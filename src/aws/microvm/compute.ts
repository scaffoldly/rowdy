import type { StartLiveTailCommandInput } from '@aws-sdk/client-cloudwatch-logs';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CreateRoleCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  CreateMicrovmAuthTokenCommand,
  CreateMicrovmImageCommand,
  CreateMicrovmImageCommandInput,
  GetMicrovmCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageCommandOutput,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
  ListManagedMicrovmImageVersionsCommand,
  ListMicrovmsCommand,
  ListTagsCommand,
  paginateListMicrovmImages,
  paginateListMicrovms,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
  UpdateMicrovmImageCommand,
} from '@aws-sdk/client-lambda-microvms';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { createHash } from 'crypto';
import { zipSync } from 'fflate';
import promiseRetry from 'promise-retry';
import {
  catchError,
  concatMap,
  defer,
  filter,
  first,
  forkJoin,
  from,
  map,
  mergeMap,
  finalize,
  Observable,
  of,
  repeat,
  switchMap,
  take,
  throwIfEmpty,
  toArray,
} from 'rxjs';
import type { SandboxSummary } from '../../sandbox';
import { deploySources } from '../../api/internal/layers';
import { Transfer } from '../../api/internal/transfer';
import { Exec, ExecOutput, ExecOutputOptions } from '../../api/types';
import { Environment } from '../../environment';
import { Logger } from '../../log';
import { ExecSchema } from '../../routes';
import { ComputeSpec, MICROVM_MEMORY, SandboxCompute, SandboxError } from '../../sandbox/internal/compute';
import { LambdaImageService } from '../lambda/image';
import {
  _create,
  isNotFound,
  isPropagating,
  isTransient,
  LambdaFunction,
  PROPAGATION,
  ROWDY_BIN,
} from '../lambda/index';
import { AwsClientLogger } from '../logger';
import { EXEC_LOG } from '../../proxy/shell';
import { execOf, execOutput, framesOf } from '../exec';
import { EXEC_ID_HEADER, EXEC_PATH, HOOKS_PORT } from '../microvm';
import { ownedBucket } from '../s3';

const BUCKET_PREFIX = 'rowdy-sandboxes-';
const BUCKET_OWNER = { Key: 'rowdy:owner', Value: 'rowdy-sandboxes' };
const COMPUTE_TAG = 'run.rowdy.aws';
const ARCHITECTURE = 'X86_64';

const TIMEOUT_TAG = 'run.rowdy.timeout';
const DEAD: ReadonlyArray<string> = ['TERMINATING', 'TERMINATED'];

/** How often a build is polled, in milliseconds. */
export const POLL = { delay: 5000 };

/** How often a terminating VM is polled, in milliseconds. */
export const TERMINATE_POLL = { delay: 250 };

type Vm = { microvmId: string; endpoint: string; imageVersion: string; startedAt: Date };

export class MicrovmCompute extends AwsClientLogger implements SandboxCompute {
  static readonly env = {};

  static list(): Observable<SandboxSummary> {
    const microvms = new LambdaMicrovmsClient({});
    return forkJoin([
      from(paginateListMicrovms({ client: microvms }, {})).pipe(
        concatMap(({ items = [] }) => items),
        toArray()
      ),
      from(paginateListMicrovmImages({ client: microvms }, {})).pipe(
        concatMap(({ items = [] }) => items),
        toArray()
      ),
    ]).pipe(
      switchMap(([vms, images]) =>
        from(images).pipe(
          mergeMap(
            ({ imageArn, name }) =>
              from(microvms.send(new ListTagsCommand({ Resource: imageArn }))).pipe(
                // An image of the account's own, not a sandbox, has no compute tag.
                filter(({ Tags }) => Tags?.[COMPUTE_TAG] === 'microvm'),
                map(({ Tags }): SandboxSummary => {
                  const [live] = vms.filter(
                    ({ imageArn: arn, state }) => arn === imageArn && state && !DEAD.includes(state)
                  );
                  const seconds = Number(Tags?.[TIMEOUT_TAG]);
                  return {
                    sandboxId: imageArn!,
                    name: name!,
                    runtime: 'aws.microvm',
                    running: !!live,
                    startedAt: live?.startedAt,
                    stopsAt:
                      live?.startedAt && seconds ? new Date(live.startedAt.getTime() + seconds * 1000) : undefined,
                  };
                })
              ),
            Environment.CONCURRENCY
          )
        )
      ),
      finalize(() => microvms.destroy())
    );
  }

  static assert({ timeout, memory, env }: Pick<ComputeSpec, 'timeout' | 'memory' | 'env'>): void {
    if (!Number.isInteger(timeout / 1000) || timeout < 1000 || timeout > 28_800_000) {
      throw new RangeError(`timeout must be whole seconds from 1000 to 28800000 ms, got ${timeout}`);
    }
    if (!(MICROVM_MEMORY as readonly number[]).includes(memory)) {
      throw new RangeError(`memory must be one of ${MICROVM_MEMORY.join(', ')}, got ${memory}`);
    }
    if (Object.keys(env).length > 50) {
      throw new RangeError(`env must have at most 50 variables, got ${Object.keys(env).length}`);
    }
  }

  readonly stoppable = true;

  private iam = this.track(new IAMClient({ logger: this }));
  private microvms = this.track(new LambdaMicrovmsClient({ logger: this }));
  private s3 = this.track(new S3Client({ logger: this }));
  private sts = this.track(new STSClient({ logger: this }));

  private images: LambdaImageService;
  private imageArn?: string;
  private commands = new Set<AbortController>();

  constructor(private environment: Environment) {
    super();
    this.images = new LambdaImageService(environment).withLayersFrom(deploySources(undefined));
  }

  override get log(): Logger {
    return this.environment.log.child('deploy');
  }

  get sandboxId(): string {
    if (!this.imageArn) {
      throw new Error('Sandbox has no image');
    }
    return this.imageArn;
  }

  create({ image, name, timeout, memory, env }: ComputeSpec): Observable<this> {
    return forkJoin({
      ImageUri: this.pull(image),
      Bucket: ownedBucket(this.s3, this.log, BUCKET_PREFIX, BUCKET_OWNER),
      baseImageArn: this.baseImage(),
      Region: from(this.s3.config.region()),
      Identity: from(this.sts.send(new GetCallerIdentityCommand({}))),
    }).pipe(
      switchMap(({ ImageUri, Bucket, baseImageArn, Region, Identity }) => {
        const RoleName = LambdaFunction.roleName(Transfer.normalizeImage(image), name);
        const imageIdentifier = `arn:aws:lambda:${Region}:${Identity.Account}:microvm-image:${name}`;
        const Key = `${name}/${ImageUri}.zip`;

        return this.role(RoleName, Bucket, Key, ImageUri).pipe(
          switchMap((buildRoleArn) =>
            this.build(imageIdentifier, Bucket, Key, ImageUri, {
              name,
              baseImageArn,
              buildRoleArn,
              cpuConfigurations: [{ architecture: ARCHITECTURE }],
              additionalOsCapabilities: ['ALL'],
              resources: [{ minimumMemoryInMiB: memory }],
              environmentVariables: env,
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
                [TIMEOUT_TAG]: `${timeout / 1000}`,
                'run.rowdy.user.agent': this.images.userAgent,
              },
            })
          ),
          map(() => {
            this.imageArn = imageIdentifier;
            return this;
          })
        );
      })
    );
  }

  attach(sandboxId: string): Observable<this> {
    return defer(() => this.microvms.send(new ListTagsCommand({ Resource: sandboxId }))).pipe(
      map(({ Tags }) => {
        if (Tags?.[COMPUTE_TAG] !== 'microvm') {
          throw new SandboxError(`Not a sandbox: ${sandboxId}`);
        }
        this.imageArn = sandboxId;
        return this;
      })
    );
  }

  exec(event: ExecSchema): Observable<Exec> {
    const controller = new AbortController();
    this.commands.add(controller);

    return defer(() => this.vm()).pipe(
      switchMap(({ microvmId, endpoint, imageVersion, startedAt }) =>
        from(
          this.microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: this.sandboxId, imageVersion }))
        ).pipe(
          switchMap(({ logging }) =>
            this.post(microvmId, endpoint, event, controller.signal).pipe(
              switchMap((response) => {
                const [, , , region, account] = this.sandboxId.split(':');
                const execId = response.headers.get(EXEC_ID_HEADER) ?? '';
                // A stream is named after the VM's start, so one that crosses midnight keeps its day.
                const day = startedAt.toISOString().slice(0, 10).replace(/-/g, '/');
                const locator: StartLiveTailCommandInput = {
                  logGroupIdentifiers: [`arn:aws:logs:${region}:${account}:log-group:${logging?.cloudWatch?.logGroup}`],
                  logStreamNamePrefixes: [`${day}[${imageVersion}]${microvmId}`],
                  logEventFilterPattern: `"${EXEC_LOG.key}" "${execId}"`,
                };
                const cmdId = Buffer.from(JSON.stringify(locator)).toString('base64url');
                return execOf(() => cmdId, from(response.body!).pipe(framesOf()));
              })
            )
          )
        )
      ),
      finalize(() => {
        this.commands.delete(controller);
        controller.abort();
      })
    );
  }

  output(cmdId: string, options?: ExecOutputOptions): Observable<ExecOutput> {
    return defer(() => this.microvms.send(new GetMicrovmImageCommand({ imageIdentifier: this.sandboxId }))).pipe(
      switchMap(({ latestActiveImageVersion: imageVersion }) =>
        this.microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: this.sandboxId, imageVersion }))
      ),
      switchMap(({ logging }) => {
        const [, , , region, account] = this.sandboxId.split(':');
        const logGroup = logging?.cloudWatch?.logGroup;
        return execOutput(`arn:aws:logs:${region}:${account}:log-group:${logGroup}`, cmdId, options);
      })
    );
  }

  stop(): Observable<this> {
    return defer(() => this.microvms.send(new ListMicrovmsCommand({ imageIdentifier: this.sandboxId }))).pipe(
      switchMap(({ items = [] }) => {
        const live = items.flatMap(({ microvmId, state }) =>
          microvmId && state && !DEAD.includes(state) ? microvmId : []
        );
        // A VM's end doesn't reach an open response until the connection times out, a minute later.
        this.commands.forEach((controller) => controller.abort(new Error('Sandbox stopped')));
        return live.length ? forkJoin(live.map((microvmIdentifier) => this.terminate(microvmIdentifier))) : of([]);
      }),
      map(() => this)
    );
  }

  /** Completes once the VM is gone, so a next command can't land on one that's ending. */
  private terminate(microvmIdentifier: string): Observable<string | undefined> {
    return from(this.microvms.send(new TerminateMicrovmCommand({ microvmIdentifier }))).pipe(
      catchError((error) => {
        // One that ended since the listing is what stop wanted.
        if (isNotFound(error) || error?.name === 'ConflictException') return of(undefined);
        throw error;
      }),
      switchMap(() =>
        defer(() => this.microvms.send(new GetMicrovmCommand({ microvmIdentifier }))).pipe(
          map(({ state }) => state),
          catchError((error) => {
            if (isNotFound(error)) return of(undefined);
            throw error;
          }),
          repeat({ delay: TERMINATE_POLL.delay }),
          first((state) => state === undefined || DEAD.includes(state))
        )
      )
    );
  }

  /** This image's VM, started if it has none, and where its command output lands. */
  private vm(): Observable<Vm> {
    const imageIdentifier = this.sandboxId;
    const region = imageIdentifier.split(':')[3];

    return defer(() => this.microvms.send(new GetMicrovmImageCommand({ imageIdentifier }))).pipe(
      switchMap(({ latestActiveImageVersion: imageVersion, tags }) =>
        from(this.microvms.send(new ListMicrovmsCommand({ imageIdentifier }))).pipe(
          switchMap(({ items = [] }) => {
            const live = items.find(({ state }) => state && !DEAD.includes(state));
            if (live?.microvmId) return of(live.microvmId);

            return from(this.microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier, imageVersion }))).pipe(
              switchMap(({ buildRoleArn: executionRoleArn }) => {
                const seconds = Number(tags?.[TIMEOUT_TAG]) || 900;
                const connector = (id: string): string =>
                  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:${id}`;
                return this.microvms.send(
                  new RunMicrovmCommand({
                    imageIdentifier,
                    imageVersion,
                    executionRoleArn,
                    ingressNetworkConnectors: [connector('HTTP_INGRESS')],
                    egressNetworkConnectors: [connector('INTERNET_EGRESS')],
                    maximumDurationInSeconds: seconds,
                    // Output doesn't count as traffic, so a quiet command must not look idle.
                    idlePolicy: {
                      maxIdleDurationSeconds: Math.min(seconds, 28_800),
                      suspendedDurationSeconds: 60,
                      autoResumeEnabled: true,
                    },
                  })
                );
              }),
              map(({ microvmId }) => microvmId!)
            );
          })
        )
      ),
      switchMap((microvmIdentifier) =>
        defer(() => this.microvms.send(new GetMicrovmCommand({ microvmIdentifier }))).pipe(
          repeat({ delay: POLL.delay }),
          first(({ state }) => state !== 'PENDING')
        )
      ),
      map(({ microvmId, state, stateReason, endpoint, imageVersion, startedAt }) => {
        if (state === undefined || DEAD.includes(state)) {
          throw new Error(`Sandbox ${imageIdentifier} stopped: ${stateReason ?? state}`);
        }
        return { microvmId: microvmId!, endpoint: endpoint!, imageVersion: imageVersion!, startedAt: startedAt! };
      })
    );
  }

  /** Hands the command to rowdy in the VM, whose response carries its frames as they happen. */
  private post(
    microvmIdentifier: string,
    endpoint: string,
    event: ExecSchema,
    signal: AbortSignal
  ): Observable<globalThis.Response> {
    return defer(() =>
      this.microvms.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier,
          expirationInMinutes: 5,
          allowedPorts: [{ port: HOOKS_PORT }],
        })
      )
    ).pipe(
      switchMap(({ authToken }) =>
        fetch(`https://${endpoint}${EXEC_PATH}`, {
          method: 'POST',
          headers: { ...authToken, 'X-aws-proxy-port': `${HOOKS_PORT}` },
          body: JSON.stringify(event),
          signal,
        })
      ),
      map((response) => {
        if (!response.ok || !response.body) {
          throw new Error(`Command refused: ${response.status}`);
        }
        return response;
      })
    );
  }

  private pull(image: string): Observable<string> {
    return defer(() =>
      this.images.pullImage({
        $typeName: 'runtime.v1.PullImageRequest',
        image: {
          $typeName: 'runtime.v1.ImageSpec',
          image,
          annotations: {},
          runtimeHandler: '',
          userSpecifiedImage: '',
        },
      })
    ).pipe(map(({ imageRef }) => imageRef));
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

  /** Builds and runs the sandbox, so code in it has this role too: it reads its one zip and pulls its one repository. */
  private role(RoleName: string, Bucket: string, Key: string, ImageUri: string): Observable<string> {
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
    const [registry = '', ...repository] = (ImageUri.split('@')[0] ?? '').split('/');
    const [account, , , region] = registry.split('.');

    return _create(
      () =>
        this.iam
          .send(new UpdateAssumeRolePolicyCommand({ RoleName, PolicyDocument: AssumeRolePolicyDocument }))
          .then(() => this.iam.send(new GetRoleCommand({ RoleName }))),
      () =>
        this.iam.send(
          new CreateRoleCommand({
            RoleName,
            Description: 'Builds and runs a rowdy sandbox',
            AssumeRolePolicyDocument,
          })
        )
    ).pipe(
      switchMap(({ Role }) =>
        from(
          this.iam.send(
            new PutRolePolicyCommand({
              RoleName,
              PolicyName: 'RowdyPolicy',
              PolicyDocument: JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                  { Effect: 'Allow', Action: ['s3:GetObject'], Resource: `arn:aws:s3:::${Bucket}/${Key}` },
                  {
                    Effect: 'Allow',
                    Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                    Resource: '*',
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
          )
        ).pipe(map(() => Role!.Arn!))
      )
    );
  }

  /** Builds only if there's no usable image from this exact Dockerfile, and waits for the result. */
  private build(
    imageIdentifier: string,
    Bucket: string,
    Key: string,
    ImageUri: string,
    spec: CreateMicrovmImageCommandInput
  ): Observable<string> {
    const Body = zipSync({
      Dockerfile: [Buffer.from(`FROM ${ImageUri}\nENTRYPOINT ["${ROWDY_BIN}"]\n`), { mtime: new Date(2000, 0) }],
    });
    const etag = `"${createHash('md5').update(Body).digest('hex')}"`;

    return forkJoin({
      image: this.settled(imageIdentifier),
      head: from(this.s3.send(new HeadObjectCommand({ Bucket, Key }))).pipe(catchError(() => of(undefined))),
    }).pipe(
      switchMap(({ image, head }) => {
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
          switchMap(({ imageVersion }) => this.version(imageIdentifier, spec.name!, imageVersion!))
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
      repeat({ delay: POLL.delay }),
      first((image) => !image?.state?.endsWith('ING'))
    );
  }

  private version(imageIdentifier: string, name: string, imageVersion: string): Observable<string> {
    return defer(() => this.microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier, imageVersion }))).pipe(
      repeat({ delay: POLL.delay }),
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
