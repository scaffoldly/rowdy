import { CloudWatchLogsClient, CreateLogGroupCommand, DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  CreateMicrovmImageCommand,
  CreateMicrovmImageCommandInput,
  DeleteMicrovmImageCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageCommandOutput,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
  ListManagedMicrovmImageVersionsCommand,
  UpdateMicrovmImageCommand,
} from '@aws-sdk/client-lambda-microvms';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { createHash } from 'crypto';
import { zipSync } from 'fflate';
import promiseRetry from 'promise-retry';
import {
  BehaviorSubject,
  catchError,
  combineLatest,
  concat,
  concatMap,
  defer,
  EMPTY,
  filter,
  first,
  forkJoin,
  from,
  fromEvent,
  map,
  merge,
  Observable,
  of,
  repeat,
  ReplaySubject,
  switchMap,
  take,
  takeUntil,
  tap,
  throwError,
  throwIfEmpty,
} from 'rxjs';
import { ROWDY_LAYERS } from '../../api/internal/layers';
import { Transfer } from '../../api/internal/transfer';
import type { Logger } from '../../log';
import type { SandboxEnvironment } from '../../sandbox/internal/environment';
import { DEFAULTS } from '../../sandbox/internal/compute';
import { AwsResource, type AwsSteps } from '../resource';
import { META_TAG } from '../tags';
import {
  _create,
  isNotFound,
  isPropagating,
  isTransient,
  PROPAGATION,
  roleName,
  ROWDY_BIN,
  SANDBOX_ROLE_PATH,
} from '../shared';
import { ownedBucket } from '../s3';
import { HOOKS_PORT } from './hooks';

export const BUCKET_PREFIX = 'rowdy-sandboxes-';
const BUCKET_OWNER = { Key: 'rowdy:owner', Value: 'rowdy-sandboxes' };
export const COMPUTE_TAG = 'run.rowdy.aws';
export const TIMEOUT_TAG = 'run.rowdy.timeout';
export const ARCHITECTURE = 'X86_64';

/** How often a build is polled, in milliseconds. */
export const POLL = { delay: 5000 };

const gone = (error: unknown): Observable<never> => (isNotFound(error) ? EMPTY : throwError(() => error));

/**
 * A sandbox's image on Lambda MicroVMs, and what rowdy makes for it: its image copied into ECR, its zip in the account's
 * sandbox bucket, its log group, and its role under the sandbox path. `observe` makes or updates all of them, and
 * `delete` takes them down, the image last.
 */
export class MicrovmImage extends AwsResource {
  private iam = this.track(new IAMClient({ logger: this, credentials: this.environment.credentials }));
  private logs = this.track(new CloudWatchLogsClient({ logger: this, credentials: this.environment.credentials }));
  private microvms = this.track(new LambdaMicrovmsClient({ logger: this, credentials: this.environment.credentials }));
  private s3 = this.track(new S3Client({ logger: this, credentials: this.environment.credentials }));
  private sts = this.track(new STSClient({ logger: this, credentials: this.environment.credentials }));

  // Reactive Properties
  private Name = new BehaviorSubject<string>('sandbox');
  private Image = new BehaviorSubject<string>('scaffoldly/sandbox');
  private LayersFrom = new BehaviorSubject<string[]>([]);
  private Timeout = new BehaviorSubject<number>(DEFAULTS.timeout);
  private Memory = new BehaviorSubject<number>(DEFAULTS.memory);
  private Environment = new BehaviorSubject<Record<string, string>>({});
  private Meta = new BehaviorSubject<Record<string, string>>({});
  private Wait = new BehaviorSubject<boolean>(true);

  // Resource Properties
  private ImageArn = new ReplaySubject<string | undefined>(1);
  private LogGroupArn = new ReplaySubject<string | undefined>(1);
  private ImageUri = new ReplaySubject<string | undefined>(1);
  private Bucket = new ReplaySubject<string | undefined>(1);
  private Key = new ReplaySubject<string | undefined>(1);
  private BaseImageArn = new ReplaySubject<string | undefined>(1);
  private LogGroupName = new ReplaySubject<string | undefined>(1);
  private RoleName = new ReplaySubject<string | undefined>(1);
  private RoleArn = new ReplaySubject<string | undefined>(1);

  public readonly State: {
    ImageArn?: string;
    LogGroupArn?: string;
    ImageUri?: string;
    Bucket?: string;
    Key?: string;
    BaseImageArn?: string;
    LogGroupName?: string;
    RoleName?: string;
    RoleArn?: string;
  } = {};

  constructor(private environment: SandboxEnvironment) {
    super();
    merge(
      this.ImageArn.pipe(map((v) => ['ImageArn', v] as const)),
      this.LogGroupArn.pipe(map((v) => ['LogGroupArn', v] as const)),
      this.ImageUri.pipe(map((v) => ['ImageUri', v] as const)),
      this.Bucket.pipe(map((v) => ['Bucket', v] as const)),
      this.Key.pipe(map((v) => ['Key', v] as const)),
      this.BaseImageArn.pipe(map((v) => ['BaseImageArn', v] as const)),
      this.LogGroupName.pipe(map((v) => ['LogGroupName', v] as const)),
      this.RoleName.pipe(map((v) => ['RoleName', v] as const)),
      this.RoleArn.pipe(map((v) => ['RoleArn', v] as const))
    )
      .pipe(
        tap(([key, value]) => (this.State[key] = value)),
        takeUntil(fromEvent(this.signal, 'abort'))
      )
      .subscribe();
  }

  override get log(): Logger {
    return this.environment.log.child('deploy');
  }

  get signal(): AbortSignal {
    return this.environment.signal;
  }

  withName(name: string): this {
    this.Name.next(name);
    return this;
  }

  withImage(image: string, layersFrom: string[] = []): this {
    this.Image.next(image);
    this.LayersFrom.next(layersFrom);
    return this;
  }

  withTimeout(timeout: number): this {
    this.Timeout.next(timeout);
    return this;
  }

  withMemory(memory: number): this {
    this.Memory.next(memory);
    return this;
  }

  withEnvironment(env: Record<string, string>): this {
    this.Environment.next(env);
    return this;
  }

  withMeta(meta: Record<string, string>): this {
    this.Meta.next(meta);
    return this;
  }

  /** Whether `observe` waits for the build, or completes once AWS is building. */
  withWait(wait: boolean): this {
    this.Wait.next(wait);
    return this;
  }

  /** An image rowdy made before, found by its ARN, for `delete`. */
  withArn(imageArn: string): this {
    this.ImageArn.next(imageArn);
    this.Name.next(imageArn.split(':').pop()!);
    return this;
  }

  protected prepare(): AwsSteps {
    const Name = this.Name.getValue();

    const creates: Observable<unknown>[] = [
      // The account and region name its image and its log group.
      forkJoin({
        Region: from(this.s3.config.region()),
        Identity: from(this.sts.send(new GetCallerIdentityCommand({}))),
      }).pipe(
        tap(({ Region, Identity: { Account } }) => {
          this.ImageArn.next(`arn:aws:lambda:${Region}:${Account}:microvm-image:${Name}`);
          this.LogGroupArn.next(`arn:aws:logs:${Region}:${Account}:log-group:/aws/lambda-microvms/${Name}`);
        })
      ),
      // Its image, copied into ECR with rowdy's layers and the ones it's given.
      defer(() =>
        this.environment.images.pullImage(this.Image.getValue(), {
          layersFrom: [ROWDY_LAYERS, ...this.LayersFrom.getValue()],
        })
      ).pipe(
        tap(({ ImageUri }) => {
          this.ImageUri.next(ImageUri);
          this.Key.next(`${Name}/${ImageUri}.zip`);
        })
      ),
      ownedBucket(this.s3, this.log, BUCKET_PREFIX, BUCKET_OWNER).pipe(tap((Bucket) => this.Bucket.next(Bucket))),
      this.baseImage().pipe(tap((arn) => this.BaseImageArn.next(arn))),
      // AWS's own log group for an image of this name. It's made here, so its role can't make others.
      from(this.logs.send(new CreateLogGroupCommand({ logGroupName: `/aws/lambda-microvms/${Name}` }))).pipe(
        catchError((error) =>
          error?.name === 'ResourceAlreadyExistsException' ? of(undefined) : throwError(() => error)
        ),
        tap(() => this.LogGroupName.next(`/aws/lambda-microvms/${Name}`))
      ),
      this.role(roleName(Transfer.normalizeImage(this.Image.getValue()), Name)),
    ];

    const updates: Observable<unknown>[] = [
      // What its role may do: read its one zip, write its one log group and pull its one repository.
      combineLatest([this.RoleName, this.Bucket, this.Key, this.ImageUri, this.LogGroupArn]).pipe(
        take(1),
        switchMap(([RoleName, Bucket, Key, ImageUri, LogGroupArn]) => {
          const [registry = '', ...repository] = (ImageUri?.split('@')[0] ?? '').split('/');
          const [account, , , region] = registry.split('.');
          return this.iam.send(
            new PutRolePolicyCommand({
              RoleName,
              PolicyName: 'RowdyPolicy',
              PolicyDocument: JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                  { Effect: 'Allow', Action: ['s3:GetObject'], Resource: `arn:aws:s3:::${Bucket}/${Key}` },
                  {
                    Effect: 'Allow',
                    Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                    Resource: `${LogGroupArn}:*`,
                  },
                  { Effect: 'Allow', Action: ['ecr:GetAuthorizationToken'], Resource: '*' },
                  {
                    Effect: 'Allow',
                    Action: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
                    Resource: `arn:aws:ecr:${region}:${account}:repository/${repository.join('/')}`,
                  },
                ],
              }),
            })
          );
        })
      ),
      combineLatest([this.ImageArn, this.Bucket, this.Key, this.ImageUri, this.BaseImageArn, this.RoleArn]).pipe(
        take(1),
        switchMap(([imageIdentifier, Bucket, Key, ImageUri, baseImageArn, buildRoleArn]) =>
          this.build(imageIdentifier!, Bucket!, Key!, ImageUri!, {
            name: Name,
            baseImageArn,
            buildRoleArn,
            cpuConfigurations: [{ architecture: ARCHITECTURE }],
            additionalOsCapabilities: ['ALL'],
            resources: [{ minimumMemoryInMiB: this.Memory.getValue() }],
            environmentVariables: this.Environment.getValue(),
            hooks: {
              port: HOOKS_PORT,
              microvmImageHooks: {
                ready: 'ENABLED',
                readyTimeoutInSeconds: 120,
                validate: 'ENABLED',
                validateTimeoutInSeconds: 120,
              },
              microvmHooks: { run: 'ENABLED', runTimeoutInSeconds: 60 },
            },
            codeArtifact: { uri: `s3://${Bucket}/${Key}` },
            tags: {
              'run.rowdy': 'aws',
              [COMPUTE_TAG]: 'microvm',
              [TIMEOUT_TAG]: `${this.Timeout.getValue() / 1000}`,
              'run.rowdy.user.agent': this.environment.userAgent,
              ...Object.fromEntries(
                Object.entries(this.Meta.getValue()).map(([key, value]) => [`${META_TAG}${key}`, value])
              ),
            },
          })
        )
      ),
    ];

    // AWS deleting the image already, or done with it.
    let deleted = false;
    const deletes: Observable<unknown>[] = [
      // What it was built with, as AWS has it: its role, zip and log group.
      this.ImageArn.pipe(
        take(1),
        switchMap((imageIdentifier) =>
          defer(() => this.microvms.send(new GetMicrovmImageCommand({ imageIdentifier }))).pipe(
            catchError((error) => (isNotFound(error) ? of(undefined) : throwError(() => error))),
            switchMap((image) => {
              deleted = !image || image.state === 'DELETING' || image.state === 'DELETED';
              const imageVersion = image?.latestActiveImageVersion ?? image?.latestFailedImageVersion;
              return deleted || !imageVersion
                ? of(undefined)
                : from(this.microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier, imageVersion })));
            })
          )
        ),
        tap((version) => {
          const [, , Bucket, ...key] = (version?.codeArtifact?.uri ?? '').split('/');
          this.RoleName.next(deleted ? undefined : version?.buildRoleArn?.split('/').pop());
          this.Bucket.next(deleted ? undefined : Bucket);
          this.Key.next(deleted ? undefined : key.join('/'));
          this.LogGroupName.next(
            deleted ? undefined : (version?.logging?.cloudWatch?.logGroup ?? `/aws/lambda-microvms/${Name}`)
          );
        })
      ),
      // Only what rowdy made for this one sandbox.
      this.RoleName.pipe(
        take(1),
        filter((RoleName): RoleName is string => !!RoleName?.endsWith('.rowdy.run')),
        concatMap((RoleName) =>
          concat(
            defer(() => this.iam.send(new DeleteRolePolicyCommand({ RoleName, PolicyName: 'RowdyPolicy' }))).pipe(
              catchError(gone)
            ),
            defer(() => this.iam.send(new DeleteRoleCommand({ RoleName }))).pipe(catchError(gone))
          )
        )
      ),
      combineLatest([this.Bucket, this.Key]).pipe(
        take(1),
        filter(([Bucket, Key]) => !!Bucket?.startsWith(BUCKET_PREFIX) && !!Key),
        concatMap(([Bucket, Key]) => this.s3.send(new DeleteObjectCommand({ Bucket, Key })))
      ),
      this.LogGroupName.pipe(
        take(1),
        filter((logGroupName): logGroupName is string => !!logGroupName?.startsWith('/aws/lambda-microvms/')),
        concatMap((logGroupName) =>
          defer(() => this.logs.send(new DeleteLogGroupCommand({ logGroupName }))).pipe(catchError(gone))
        )
      ),
      // The image last, so a delete that fails before it can be repeated.
      this.ImageArn.pipe(
        take(1),
        filter(() => !deleted),
        concatMap((imageIdentifier) =>
          defer(() => this.microvms.send(new DeleteMicrovmImageCommand({ imageIdentifier }))).pipe(catchError(gone))
        )
      ),
    ];

    return { creates, updates, deletes };
  }

  /** Its role, made first: IAM checks a change to a role that isn't there yet against the name with no path. */
  private role(RoleName: string): Observable<unknown> {
    const AssumeRolePolicyDocument = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: ['sts:AssumeRole', 'sts:TagSession'],
        },
      ],
    });
    const create = (): Promise<unknown> =>
      this.iam
        .send(
          new CreateRoleCommand({
            RoleName,
            Path: SANDBOX_ROLE_PATH,
            Description: 'Builds and runs a rowdy sandbox',
            AssumeRolePolicyDocument,
          })
        )
        .catch((error) => {
          if (error?.name === 'EntityAlreadyExistsException') return undefined;
          throw error;
        });

    return defer(create).pipe(
      switchMap(() =>
        _create(
          () =>
            this.iam
              .send(new UpdateAssumeRolePolicyCommand({ RoleName, PolicyDocument: AssumeRolePolicyDocument }))
              .then(() => this.iam.send(new GetRoleCommand({ RoleName }))),
          create,
          ({ Role }) => {
            this.RoleName.next(RoleName);
            this.RoleArn.next(Role!.Arn!);
          }
        )
      )
    );
  }

  /** AWS's newest base image with a version available for this architecture. */
  private baseImage(): Observable<string> {
    return defer(() => this.microvms.send(new ListManagedMicrovmImagesCommand({}))).pipe(
      switchMap(({ items = [] }) =>
        from([...items].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)))
      ),
      concatMap(({ imageArn }) =>
        from(this.microvms.send(new ListManagedMicrovmImageVersionsCommand({ imageIdentifier: imageArn }))).pipe(
          filter(({ items = [] }) =>
            items.some(
              ({ status, supportedCpuConfigurations = [] }) =>
                status === 'AVAILABLE' && supportedCpuConfigurations.some((cpu) => cpu.architecture === ARCHITECTURE)
            )
          ),
          map(() => imageArn!)
        )
      ),
      take(1),
      throwIfEmpty(() => new Error(`AWS has no base image for ${ARCHITECTURE} in this region`))
    );
  }

  /** Builds only if there's no usable image from this exact Dockerfile, and waits for the result unless told not to. */
  private build(
    imageIdentifier: string,
    Bucket: string,
    Key: string,
    ImageUri: string,
    spec: CreateMicrovmImageCommandInput
  ): Observable<string> {
    const wait = this.Wait.getValue();
    const Body = zipSync({
      Dockerfile: [Buffer.from(`FROM ${ImageUri}\nENTRYPOINT ["${ROWDY_BIN}"]\n`), { mtime: new Date(2000, 0) }],
    });
    const etag = `"${createHash('md5').update(Body).digest('hex')}"`;

    return forkJoin({
      // Without waiting, one that's building already is left to finish.
      image: wait
        ? this.settled(imageIdentifier)
        : defer(() => this.microvms.send(new GetMicrovmImageCommand({ imageIdentifier }))).pipe(
            catchError((error) => (isNotFound(error) ? of(undefined) : throwError(() => error)))
          ),
      head: from(this.s3.send(new HeadObjectCommand({ Bucket, Key }))).pipe(catchError(() => of(undefined))),
    }).pipe(
      switchMap(({ image, head }) => {
        if (!wait && image?.state?.endsWith('ING')) return of(image.latestActiveImageVersion ?? '');
        const built = image?.state === 'CREATED' || image?.state === 'UPDATED';
        if (built && head?.ETag === etag && image.latestActiveImageVersion) {
          this.log.debug('Sandbox Image Reused', { version: image.latestActiveImageVersion });
          return of(image.latestActiveImageVersion);
        }

        const { name: _name, tags: _tags, ...update } = spec;
        return from(this.s3.send(new PutObjectCommand({ Bucket, Key, Body }))).pipe(
          switchMap(() =>
            promiseRetry<{ imageVersion?: string }>(
              (retry) =>
                (image
                  ? this.microvms.send(new UpdateMicrovmImageCommand({ imageIdentifier, ...update }))
                  : this.microvms.send(new CreateMicrovmImageCommand(spec))
                ).catch((error) => {
                  if (isPropagating(error) || isTransient(error)) return retry(error);
                  throw error;
                }),
              PROPAGATION
            )
          ),
          switchMap(({ imageVersion }) =>
            wait ? this.version(imageIdentifier, spec.name!, imageVersion!) : of(imageVersion!)
          )
        );
      })
    );
  }

  /** The image once nothing is changing it, or undefined if there isn't one. */
  private settled(imageIdentifier: string): Observable<GetMicrovmImageCommandOutput | undefined> {
    return defer(() => this.microvms.send(new GetMicrovmImageCommand({ imageIdentifier }))).pipe(
      catchError((error) => {
        if (isNotFound(error)) return of(undefined);
        throw error;
      }),
      repeat({ delay: this.environment.pollInterval ?? POLL.delay }),
      first((image) => !image?.state?.endsWith('ING'))
    );
  }

  private version(imageIdentifier: string, name: string, imageVersion: string): Observable<string> {
    return defer(() => this.microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier, imageVersion }))).pipe(
      repeat({ delay: this.environment.pollInterval ?? POLL.delay }),
      first(({ state }) => state === 'SUCCESSFUL' || state === 'FAILED'),
      map(({ state, stateReason }) => {
        if (state === 'FAILED') {
          throw new Error(`Sandbox ${name} failed to build: ${stateReason}. Logs: /aws/lambda-microvms/${name}`);
        }
        return imageVersion;
      })
    );
  }
}
