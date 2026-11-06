import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CreateRoleCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  CreateMicrovmImageCommand,
  CreateMicrovmImageCommandInput,
  GetMicrovmImageCommand,
  GetMicrovmImageCommandOutput,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
  ListManagedMicrovmImageVersionsCommand,
  ListTagsCommand,
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
  Observable,
  of,
  repeat,
  switchMap,
  take,
  throwError,
  throwIfEmpty,
} from 'rxjs';
import { deploySources } from '../../api/internal/layers';
import { Transfer } from '../../api/internal/transfer';
import { Exec } from '../../api/types';
import { Environment } from '../../environment';
import { Logger } from '../../log';
import { ExecSchema } from '../../routes';
import { ComputeSpec, MICROVM_MEMORY, SandboxCompute } from '../../sandbox/internal/compute';
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
import { HOOKS_PORT } from '../microvm';
import { ownedBucket } from '../s3';

const BUCKET_PREFIX = 'rowdy-sandboxes-';
const BUCKET_OWNER = { Key: 'rowdy:owner', Value: 'rowdy-sandboxes' };
const COMPUTE_TAG = 'run.rowdy.aws';
const ARCHITECTURE = 'X86_64';

/** How often a build is polled, in milliseconds. */
export const POLL = { delay: 5000 };

export class MicrovmCompute extends AwsClientLogger implements SandboxCompute {
  static readonly env = {};

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

  private iam = new IAMClient({ logger: this });
  private microvms = new LambdaMicrovmsClient({ logger: this });
  private s3 = new S3Client({ logger: this });
  private sts = new STSClient({ logger: this });

  private images: LambdaImageService;
  private imageArn?: string;

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

  create({ image, name, memory, env }: ComputeSpec): Observable<this> {
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
        const Key = `${name}/code.zip`;

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
          throw new Error(`Not a sandbox: ${sandboxId}`);
        }
        this.imageArn = sandboxId;
        return this;
      })
    );
  }

  exec(_event: ExecSchema): Observable<Exec> {
    return throwError(() => new Error('runCommand is not implemented on compute microvm'));
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
