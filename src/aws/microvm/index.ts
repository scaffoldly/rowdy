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
  ManagedMicrovmImageVersion,
  ListManagedMicrovmImagesCommand,
  ListManagedMicrovmImageVersionsCommand,
  UpdateMicrovmImageCommand,
} from '@aws-sdk/client-lambda-microvms';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { createHash } from 'crypto';
import { DockerfileParser } from 'dockerfile-ast';
import { readFileSync } from 'fs';
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
  retry,
  switchMap,
  take,
  takeUntil,
  tap,
  throwError,
  throwIfEmpty,
  timer,
} from 'rxjs';
import { ROWDY_LAYERS } from '../../api/internal/layers';
import type { PullImageOptions, TPulledImage } from '../../api/types';
import { Transfer } from '../../api/internal/transfer';
import type { Logger } from '../../log';
import type { SandboxEnvironment } from '../../sandbox/internal/environment';
import { DEFAULTS } from '../../sandbox/internal/compute';
import { AwsResource, type AwsSteps } from '../resource';
import { META_TAG, TAG_VALUE_REGEX } from '../tags';
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
export const BUCKET_OWNER = { Key: 'rowdy:owner', Value: 'rowdy-sandboxes' };
export const COMPUTE_TAG = 'run.rowdy.aws';
export const TIMEOUT_TAG = 'run.rowdy.timeout';

/** How often a build is polled, in milliseconds. */
export const POLL = { delay: 5000 };

const gone = (error: unknown): Observable<never> => (isNotFound(error) ? EMPTY : throwError(() => error));

/** The hooks rowdy's runtime serves in the VM, with how long each may take. */
const HOOKS = {
  port: HOOKS_PORT,
  microvmImageHooks: {
    ready: 'ENABLED',
    readyTimeoutInSeconds: 120,
    validate: 'ENABLED',
    validateTimeoutInSeconds: 120,
  },
  microvmHooks: { run: 'ENABLED', runTimeoutInSeconds: 60 },
} satisfies CreateMicrovmImageCommandInput['hooks'];
const CAPABILITIES: NonNullable<CreateMicrovmImageCommandInput['additionalOsCapabilities']> = ['ALL'];

/**
 * What a prebuilt image is built from, as its build-spec hash covers it. Its layers go in by the references asked for,
 * not their digests, and rowdy's version and ECR copy not at all, so an image keeps matching across rowdy releases and
 * layer pushes with the layers it was built with. Those are in its tags, outside the hash.
 */
export type PrebuildSpec = {
  registry: string;
  namespace: string;
  name: string;
  tag: string;
  sha256: string;
  platform: string;
  layers: string[];
  entrypoint: string;
  baseImageArn: string;
  baseImageVersion: string;
  architecture: string;
  additionalOsCapabilities: string[];
  minimumMemoryInMiB: number;
  environmentVariables: string;
  hooks: CreateMicrovmImageCommandInput['hooks'];
  egressNetworkConnectors: string[];
};

/** A prebuilt image as `prebuilt` resolves it: its name, spec, spec hash and tags, and what they came from. */
export type Prebuilt = {
  name: string;
  spec: PrebuildSpec;
  hash: string;
  tags: Record<string, string>;
  pulled: TPulledImage;
  dockerfile: string;
  baseImageArn: string;
  baseImageVersion: string;
};

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
  private Platform = new BehaviorSubject<NonNullable<PullImageOptions['platform']>>('linux/amd64');
  private Prebuild = new BehaviorSubject<boolean>(false);
  private BuiltFrom = new BehaviorSubject<string | undefined>(undefined);

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
  private BaseImageVersion = new ReplaySubject<string | undefined>(1);
  private Pulled = new ReplaySubject<TPulledImage>(1);
  private Dockerfile = new ReplaySubject<string>(1);
  private Spec = new ReplaySubject<Prebuilt>(1);
  private Built = new ReplaySubject<boolean>(1);

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
    BaseImageVersion?: string;
    /** Whether `observe` built the image, or found it built already. */
    Built?: boolean;
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
      this.RoleArn.pipe(map((v) => ['RoleArn', v] as const)),
      this.BaseImageVersion.pipe(map((v) => ['BaseImageVersion', v] as const)),
      this.Built.pipe(map((v) => ['Built', v] as const))
    )
      .pipe(
        tap(([key, value]) => Object.assign(this.State, { [key]: value })),
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

  /** The platform its image is copied for, from a multi-platform index, and so its architecture. */
  withPlatform(platform: NonNullable<PullImageOptions['platform']>): this {
    this.Platform.next(platform);
    return this;
  }

  /** The Dockerfile its image was built from, whose last stage's FROM a prebuilt image is tagged with. */
  withDockerfile(path: string): this {
    this.BuiltFrom.next(path);
    return this;
  }

  /**
   * Builds the image for no sandbox, named for what it's built from: the first 40 hex of the platform image's digest
   * and the first 23 of the build-spec hash. Tagged with every field of its `PrebuildSpec`, and none of a sandbox's.
   */
  withPrebuild(): this {
    this.Prebuild.next(true);
    return this;
  }

  /** An image rowdy made before, found by its ARN, for `delete`. */
  withArn(imageArn: string): this {
    this.ImageArn.next(imageArn);
    this.Name.next(imageArn.split(':').pop()!);
    return this;
  }

  protected prepare(): AwsSteps {
    const Prebuild = this.Prebuild.getValue();
    const Platform = this.Platform.getValue();
    const architecture = Platform === 'linux/arm64' ? 'ARM_64' : 'X86_64';
    // What an image is built with, apart from its name, base, role, zip and tags.
    const request = {
      cpuConfigurations: [{ architecture }],
      additionalOsCapabilities: CAPABILITIES,
      resources: [{ minimumMemoryInMiB: this.Memory.getValue() }],
      environmentVariables: this.Environment.getValue(),
      hooks: HOOKS,
    } satisfies Partial<CreateMicrovmImageCommandInput>;
    // A prebuilt image's name is known once its image is copied and its base is picked.
    const Name$ = Prebuild ? this.Spec.pipe(map(({ name }) => name)) : of(this.Name.getValue());

    const creates: Observable<unknown>[] = [
      // The account and region name its image and its log group.
      forkJoin({
        Region: defer(() => this.s3.config.region()),
        Identity: defer(() => this.sts.send(new GetCallerIdentityCommand({}))),
        Name: Name$.pipe(take(1)),
      }).pipe(
        tap(({ Region, Identity: { Account }, Name }) => {
          this.ImageArn.next(`arn:aws:lambda:${Region}:${Account}:microvm-image:${Name}`);
          this.LogGroupArn.next(`arn:aws:logs:${Region}:${Account}:log-group:/aws/lambda-microvms/${Name}`);
        })
      ),
      ...(Prebuild
        ? [
            // Its image copied, its base picked and its spec resolved, together: the spec names it.
            this.prebuilt().pipe(
              tap((prebuilt) => {
                this.Name.next(prebuilt.name);
                this.Pulled.next(prebuilt.pulled);
                this.ImageUri.next(prebuilt.pulled.ImageUri);
                this.Dockerfile.next(prebuilt.dockerfile);
                this.BaseImageArn.next(prebuilt.baseImageArn);
                this.BaseImageVersion.next(prebuilt.baseImageVersion);
                this.Spec.next(prebuilt);
              })
            ),
          ]
        : [
            // Its image, copied into ECR with rowdy's layers and the ones it's given.
            defer(() =>
              this.environment.images.pullImage(this.Image.getValue(), {
                layersFrom: [ROWDY_LAYERS, ...this.LayersFrom.getValue()],
                platform: Platform,
              })
            ).pipe(
              tap((pulled) => {
                this.Pulled.next(pulled);
                this.ImageUri.next(pulled.ImageUri);
                this.Dockerfile.next(`FROM ${pulled.ImageUri}\nENTRYPOINT ["${ROWDY_BIN}"]\n`);
              })
            ),
            this.baseImage(architecture).pipe(
              tap(({ imageArn, imageVersion }) => {
                this.BaseImageArn.next(imageArn);
                this.BaseImageVersion.next(imageVersion);
              })
            ),
          ]),
      combineLatest([Name$, this.ImageUri]).pipe(
        take(1),
        tap(([Name, ImageUri]) => this.Key.next(`${Name}/${ImageUri}.zip`))
      ),
      ownedBucket(this.s3, this.log, BUCKET_PREFIX, BUCKET_OWNER).pipe(tap((Bucket) => this.Bucket.next(Bucket))),
      // AWS's own log group for an image of this name. It's made here, so its role can't make others.
      Name$.pipe(
        take(1),
        switchMap((Name) =>
          defer(() => this.logs.send(new CreateLogGroupCommand({ logGroupName: `/aws/lambda-microvms/${Name}` }))).pipe(
            catchError((error) =>
              error?.name === 'ResourceAlreadyExistsException' ? of(undefined) : throwError(() => error)
            ),
            tap(() => this.LogGroupName.next(`/aws/lambda-microvms/${Name}`))
          )
        )
      ),
      Name$.pipe(
        take(1),
        switchMap((Name) => this.role(roleName(Transfer.normalizeImage(this.Image.getValue()), Name)))
      ),
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
    ];

    if (Prebuild) {
      updates.push(
        // The whole spec beside its zip, for what its tags only hash.
        combineLatest([this.Bucket, this.Spec]).pipe(
          take(1),
          switchMap(([Bucket, { name, spec, hash, tags }]) =>
            this.s3.send(
              new PutObjectCommand({
                Bucket,
                Key: `${name}/spec.json`,
                Body: JSON.stringify({ ...spec, spec: hash, tags }),
                ContentType: 'application/json',
              })
            )
          )
        )
      );
    }

    updates.push(
      combineLatest([
        Name$,
        this.ImageArn,
        this.Bucket,
        this.Key,
        this.Dockerfile,
        this.BaseImageArn,
        this.BaseImageVersion,
        this.RoleArn,
        Prebuild ? this.Spec.pipe(map(({ tags }) => tags)) : of(undefined),
      ]).pipe(
        take(1),
        switchMap(
          ([Name, imageIdentifier, Bucket, Key, Dockerfile, baseImageArn, baseImageVersion, buildRoleArn, prebuilt]) =>
            this.build(imageIdentifier!, Bucket!, Key!, Dockerfile, {
              name: Name,
              baseImageArn,
              baseImageVersion,
              buildRoleArn,
              ...request,
              codeArtifact: { uri: `s3://${Bucket}/${Key}` },
              // A prebuilt image is no one's sandbox: none of a sandbox's tags, so nothing lists or deletes it as one.
              tags: prebuilt ?? {
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
      )
    );

    const Name = this.Name.getValue();
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
          defer(() => this.microvms.send(new DeleteMicrovmImageCommand({ imageIdentifier }))).pipe(
            // A stopped sandbox's VMs can still be terminating, and AWS keeps an image with VMs on it.
            retry({
              count: 60,
              delay: (error) =>
                /running microvms/i.test(`${error?.message}`)
                  ? timer(this.environment.pollInterval ?? POLL.delay)
                  : throwError(() => error),
            }),
            catchError(gone)
          )
        )
      ),
    ];

    return { creates, updates, deletes };
  }

  /**
   * What a prebuilt image of this one is built from, and the name that follows. Its image is copied into ECR, or with
   * `upload` false only named as it would be there, so a lookup can find a prebuilt image without copying anything.
   */
  prebuilt(upload = true): Observable<Prebuilt> {
    const Platform = this.Platform.getValue();
    const architecture = Platform === 'linux/arm64' ? 'ARM_64' : 'X86_64';
    return forkJoin({
      pulled: defer(() =>
        this.environment.images.pullImage(this.Image.getValue(), {
          layersFrom: [ROWDY_LAYERS, ...this.LayersFrom.getValue()],
          platform: Platform,
          upload,
        })
      ),
      base: this.baseImage(architecture),
      // The Dockerfile's last stage's FROM, with its digest for this platform. Not one it can't know, like an earlier
      // stage, scratch or an ARG with no default, and none at all if it can't be read: it's only a tag.
      from: defer(() => {
        const path = this.BuiltFrom.getValue();
        if (!path) return of(undefined);
        const dockerfile = DockerfileParser.parse(readFileSync(path, 'utf8'));
        const froms = dockerfile.getFROMs();
        const last = froms[froms.length - 1];
        const line = last?.getRange().start.line ?? 0;
        let unknown = false;
        const ref = (last?.getImage() ?? '').replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, variable: string) => {
          const value = dockerfile.resolveVariable(variable, line);
          if (value === null || value === undefined) unknown = true;
          return value ?? '';
        });
        const stages = froms.slice(0, -1).map((from) => from.getBuildStage()?.toLowerCase());
        if (!ref || unknown || ref.toLowerCase() === 'scratch' || stages.includes(ref.toLowerCase())) {
          return of(undefined);
        }
        return of(ref).pipe(
          Transfer.normalize(),
          Transfer.collect(this.log, this.environment.http, [], Platform),
          map(({ index }) => ({ name: ref, digest: index.manifests?.[0]?.digest }))
        );
      }).pipe(
        catchError((error) => {
          this.log.warn('Dockerfile Base Unknown', { error: `${error?.message ?? error}` });
          return of(undefined);
        })
      ),
    }).pipe(
      map(({ pulled, base: { imageArn: baseImageArn, imageVersion: baseImageVersion }, from }) => {
        const { Image, Source, Layers = [] } = pulled;
        const Dockerfile = `FROM ${pulled.ImageUri}\nENTRYPOINT ["${ROWDY_BIN}"]\n`;
        if (!Source?.digest) {
          throw new Error(`${Image} has no ${Platform} digest to name its image by`);
        }
        const spec: PrebuildSpec = {
          registry: Source.registry,
          namespace: Source.namespace,
          name: Source.name,
          tag: Source.tag,
          sha256: Source.digest.replace(/^sha256:/, ''),
          platform: Platform,
          layers: Layers.map(({ from }) => from),
          entrypoint: ROWDY_BIN,
          baseImageArn,
          baseImageVersion,
          architecture,
          additionalOsCapabilities: CAPABILITIES,
          minimumMemoryInMiB: this.Memory.getValue(),
          // Its values can be secrets: only their hash, by key order.
          environmentVariables: createHash('sha256')
            .update(
              JSON.stringify(
                Object.entries(this.Environment.getValue()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              )
            )
            .digest('hex'),
          hooks: HOOKS,
          egressNetworkConnectors: [],
        };
        // Built in PrebuildSpec's key order, so the same spec always encodes, and hashes, the same.
        const hash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
        // A field that isn't a tag value as it is, like a list, goes in as its hash.
        const tags = Object.fromEntries(
          Object.entries(spec).map(([key, value]) => [
            key,
            typeof value !== 'object' && TAG_VALUE_REGEX.test(`${value}`)
              ? `${value}`
              : createHash('sha256').update(JSON.stringify(value)).digest('hex'),
          ])
        );
        tags.spec = hash;
        tags.memory = `${spec.minimumMemoryInMiB}`;
        // What it was built with, and for picking the newest image of a name or of a FROM: not in the hash.
        Layers.forEach(({ from, digest }, index) => (tags[`layer.${index}`] = `${from}@${digest}`));
        tags.rowdy = this.environment.version;
        tags.built = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        // From its Dockerfile when given, else from the annotations of a build that set them.
        const base = from ?? Source.base;
        if (base && TAG_VALUE_REGEX.test(base.name)) {
          tags.from = base.name;
          if (base.digest) tags['from.sha256'] = base.digest.replace(/^sha256:/, '');
        }
        const name = `${spec.sha256.slice(0, 40)}-${hash.slice(0, 23)}`;
        this.log.info(
          `${this.Image.getValue()} is ${spec.registry}/${spec.namespace}/${spec.name}:${spec.tag}@sha256:${spec.sha256} for ${spec.platform}`
        );
        Layers.forEach(({ from, digest }) => this.log.info(`Layer ${from}@${digest}`));
        return { name, spec, hash, tags, pulled, dockerfile: Dockerfile, baseImageArn, baseImageVersion };
      })
    );
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

  /** AWS's newest base image with a version available for `architecture`, and that newest version, pinned. */
  private baseImage(architecture: string): Observable<{ imageArn: string; imageVersion: string }> {
    return defer(() => this.microvms.send(new ListManagedMicrovmImagesCommand({}))).pipe(
      switchMap(({ items = [] }) =>
        from([...items].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)))
      ),
      concatMap(({ imageArn }) =>
        from(this.microvms.send(new ListManagedMicrovmImageVersionsCommand({ imageIdentifier: imageArn }))).pipe(
          map(
            ({ items = [] }) =>
              items
                .filter(
                  ({ status, supportedCpuConfigurations = [] }) =>
                    status === 'AVAILABLE' &&
                    supportedCpuConfigurations.some((cpu) => cpu.architecture === architecture)
                )
                .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0]
          ),
          filter((version): version is ManagedMicrovmImageVersion => !!version?.imageVersion),
          map(({ imageVersion }) => ({ imageArn: imageArn!, imageVersion: imageVersion! }))
        )
      ),
      take(1),
      throwIfEmpty(() => new Error(`AWS has no base image for ${architecture} in this region`))
    );
  }

  /** Builds only if there's no usable image from this exact Dockerfile, and waits for the result unless told not to. */
  private build(
    imageIdentifier: string,
    Bucket: string,
    Key: string,
    Dockerfile: string,
    spec: CreateMicrovmImageCommandInput
  ): Observable<string> {
    const wait = this.Wait.getValue();
    const Body = zipSync({ Dockerfile: [Buffer.from(Dockerfile), { mtime: new Date(2000, 0) }] });
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
          this.Built.next(false);
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
          ),
          tap(() => this.Built.next(true))
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
