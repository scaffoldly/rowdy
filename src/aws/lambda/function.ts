import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  FunctionConfiguration,
  GetFunctionCommand,
  GetFunctionCommandOutput,
  LambdaClient,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionConfigurationRequest,
  TagResourceCommand,
  ListTagsCommand,
  FunctionCodeLocation,
  ListTagsResponse,
} from '@aws-sdk/client-lambda';
import { CloudResource } from '@scaffoldly/rowdy-cdk';
import { IamConsumer, IamRoleResource, PolicyDocument, TrustRelationship } from './iam';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../..';
import { Transfer } from '../../api/internal/transfer';

const isSubset = (subset: Record<string, string>, superset: Record<string, string>): boolean => {
  for (const key of Object.keys(subset)) {
    if (superset[key] !== subset[key]) {
      return false;
    }
  }
  return true;
};

export const ANNOTATIONS = {
  LAMBDA_ARN: 'com.amazonaws.lambda.arn',
  LAMBDA_VERSION: 'com.amazonaws.lambda.version',
  LAMBDA_ROLE: 'com.amazonaws.lambda.role',
  LAMBDA_TIMEOUT: 'com.amazonaws.lambda.timeout',
  LAMBDA_CODE_SHA256: 'com.amazonaws.lambda.codeSha256',
  LAMBDA_REVISION_ID: 'com.amazonaws.lambda.revisionId',
  ROWDY_RUNTIME: 'run.rowdy.runtime',
  ROWDY_IMAGE: 'run.rowdy.image',
  ROWDY_IMAGE_REF: 'run.rowdy.image.ref',
};

export const LABELS = {
  LAMBDA_ARCHITECTURE: 'com.amazonaws.lambda.architecture',
  LAMBDA_ENTRYPOINT: 'com.amazonaws.lambda.entrypoint',
  LAMBDA_MEMORY: 'com.amazonaws.lambda.memory',
  LAMBDA_TIMEOUT: 'com.amazonaws.lambda.timeout',
  ROWDY_IMAGE: ANNOTATIONS.ROWDY_IMAGE,
  ROWDY_RUNTIME: ANNOTATIONS.ROWDY_RUNTIME,
};

export class SandboxResource
  extends CloudResource<FunctionConfiguration, GetFunctionCommandOutput>
  implements IamConsumer
{
  private lambda = new LambdaClient({});
  private iamRole: IamRoleResource;

  get RoleArn(): PromiseLike<string> {
    return this.iamRole.RoleArn;
  }

  private get _functionName(): PromiseLike<string> {
    return this.iamRole.RoleId.then((roleId) => `${this.req.config?.metadata?.name}_${roleId}`);
  }

  private get _memorySize(): number {
    const desired = this.req.config?.linux?.resources?.memoryLimitInBytes;
    if (!desired) {
      return 1024;
    }
    return Number(desired) / 1024 / 1024;
  }

  private get _codeSha256(): string {
    const ref = this.image.imageRef.split('@sha256:')[1];
    if (!ref) {
      throw new Error('Image reference does not contain sha256 digest');
    }
    return ref;
  }

  get _registry(): string {
    const registry = this.image.imageRef.split('/')[0];
    if (!registry) {
      throw new Error('Image reference does not contain registry');
    }
    return registry;
  }

  get _accountId(): string {
    const accountId = this._registry.split('.')[0];
    if (!accountId) {
      throw new Error('Registry does not contain account ID');
    }
    return accountId;
  }

  get _variables(): Record<string, string> {
    return {
      AWS_ACCOUNT_ID: this._accountId,
      ROWDY_DEBUG: `${this.environment.log.isDebugging}`,
      ROWDY_REGISTRY: this._registry,
      ROWDY_TRACE: `${this.environment.log.isTracing}`,
    };
  }

  annotations = (fn: FunctionConfiguration): Record<string, string> => {
    return {
      [`${ANNOTATIONS.LAMBDA_ARN}`]: fn.FunctionArn ?? '',
      [`${ANNOTATIONS.LAMBDA_VERSION}`]: fn.Version?.replace('$', '') ?? '',
      [`${ANNOTATIONS.LAMBDA_ROLE}`]: fn.Role ?? '',
      [`${ANNOTATIONS.LAMBDA_TIMEOUT}`]: fn.Timeout?.toString() ?? '',
      [`${ANNOTATIONS.LAMBDA_CODE_SHA256}`]: fn.CodeSha256 ?? '',
      [`${ANNOTATIONS.LAMBDA_REVISION_ID}`]: fn.RevisionId ?? '',
      [`${ANNOTATIONS.ROWDY_RUNTIME}`]: this.req.config?.annotations?.[`${ANNOTATIONS.ROWDY_RUNTIME}`] ?? '',
      [`${ANNOTATIONS.ROWDY_IMAGE}`]: this.req.config?.annotations?.[`${ANNOTATIONS.ROWDY_IMAGE}`] ?? '',
      [`${ANNOTATIONS.ROWDY_IMAGE_REF}`]: this.image.imageRef,
    };
  };

  labels = (fn: FunctionConfiguration): Record<string, string> => {
    return {
      [`${LABELS.LAMBDA_ENTRYPOINT}`]: fn.ImageConfigResponse?.ImageConfig?.EntryPoint?.[0] ?? '',
      [`${LABELS.LAMBDA_ARCHITECTURE}`]: fn.Architectures?.[0] ?? '',
      [`${LABELS.LAMBDA_MEMORY}`]: fn.MemorySize?.toString() ?? '',
      [`${LABELS.LAMBDA_TIMEOUT}`]: fn.Timeout?.toString() ?? '',
      [`${LABELS.ROWDY_RUNTIME}`]: this.req.config?.labels?.[`${LABELS.ROWDY_RUNTIME}`] ?? '',
      [`${LABELS.ROWDY_IMAGE}`]: this.req.config?.labels?.[`${LABELS.ROWDY_IMAGE}`] ?? '',
    };
  };

  get Sandbox(): PromiseLike<CRI.PodSandbox> {
    return this.manage({ retries: 10 }).then((fn) => {
      if (!fn.FunctionArn) {
        throw new Error('Function ARN is undefined');
      }

      const sandbox: CRI.PodSandbox = {
        $typeName: 'runtime.v1.PodSandbox',
        id: fn.FunctionArn,
        state:
          !fn.LastUpdateStatus || fn.LastUpdateStatus === 'Successful'
            ? CRI.PodSandboxState.SANDBOX_READY
            : CRI.PodSandboxState.SANDBOX_NOTREADY,
        createdAt: BigInt(fn.LastModified ? new Date(fn.LastModified).getTime() : 0),
        labels: this.labels(fn),
        annotations: this.annotations(fn),
        runtimeHandler: this.req.runtimeHandler,
      };
      return sandbox;
    });
  }

  constructor(
    public readonly environment: Environment,
    protected req: CRI.RunPodSandboxRequest,
    protected image: CRI.PullImageResponse
  ) {
    super(
      {
        describe: (config) => ({ type: 'Lambda Function', label: config.FunctionName }),
        read: async () =>
          this.lambda.send(
            new GetFunctionCommand({
              FunctionName: await this._functionName,
            })
          ),
        create: async () =>
          this.lambda.send(
            new CreateFunctionCommand({
              FunctionName: await this._functionName,
              Role: await this.RoleArn,
              PackageType: 'Image',
              // TODO: Support for platform annotation
              Architectures: ['x86_64'],
              Timeout: 900,
              MemorySize: this._memorySize,
              Publish: false,
              Code: { ImageUri: image.imageRef },
              ImageConfig: { EntryPoint: ['rowdy'] },
              Environment: {
                Variables: this._variables,
              },
              // TODO: Update tags if changed
              Tags: { ...this.Tags },
            })
          ),
        update: async (existing) => {
          let updated = false;
          if (existing.CodeSha256 !== this._codeSha256) {
            existing = await this.lambda.send(
              new UpdateFunctionCodeCommand({
                FunctionName: existing.FunctionArn,
                ImageUri: this.image.imageRef,
                Publish: false,
              })
            );
            updated = true;
          }

          if (
            existing.MemorySize !== this._memorySize ||
            !isSubset(this._variables, existing.Environment?.Variables || {})
          ) {
            existing = await this.lambda.send(
              new UpdateFunctionConfigurationCommand(existing as UpdateFunctionConfigurationRequest)
            );
            updated = true;
          }

          if (updated) {
            // TODO publish new version
          }

          return existing;
        },
        tag: async (existing, tags) => {
          const desired = { ...tags, ...this.Tags, ...this.annotations(existing) };
          const current = await this.lambda
            .send(new ListTagsCommand({ Resource: existing.FunctionArn! }))
            .then((res) => res.Tags || {});

          if (isSubset(desired, current)) {
            return;
          }

          await this.lambda.send(
            new TagResourceCommand({
              Resource: existing.FunctionArn!,
              Tags: { ...tags, ...this.Tags, ...this.annotations(existing) },
            })
          );
        },
        dispose: async () => this.lambda.send(new DeleteFunctionCommand({ FunctionName: await this._functionName })),
      },
      (output) => {
        return output.Configuration || {};
      }
    );

    this.iamRole = new IamRoleResource(image).withConsumer(this);
  }

  static async from(environment: Environment, id: string): Promise<CRI.PodSandbox> {
    const client = new LambdaClient({});
    const config = await client.send(new GetFunctionCommand({ FunctionName: id }));
    const tags = await client.send(new ListTagsCommand({ Resource: id }));
    const factory = ConfigFactory.fromLambda(config.Configuration, config.Code, tags);
    const resource = new SandboxResource(environment, factory.RunPodSandboxRequest, factory.PullImageResponse);
    return resource.Sandbox;
  }

  get trustRelationship(): TrustRelationship {
    return {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Service: 'lambda.amazonaws.com',
          },
          Action: 'sts:AssumeRole',
        },
      ],
    };
  }

  get policyDocument(): PolicyDocument {
    return {
      Version: '2012-10-17',
      Statement: [
        {
          Action: [
            'lambda:Get*',
            'lambda:List*',
            'logs:CreateLogStream',
            'logs:CreateLogGroup',
            'logs:TagResource',
            'logs:PutLogEvents',
            'xray:PutTraceSegments',
            'xray:PutTelemetryRecords',
            // 'ec2:CreateNetworkInterface',
            // 'ec2:DescribeNetworkInterfaces',
            // 'ec2:DescribeSubnets',
            // 'ec2:DeleteNetworkInterface',
            // 'ec2:AssignPrivateIpAddresses',
            // 'ec2:UnassignPrivateIpAddresses',
          ],
          Resource: ['*'],
          Effect: 'Allow',
        },
      ],
    };
  }
}

export class ConfigFactory {
  private _sandboxConfig: CRI.PodSandboxConfig = {
    $typeName: 'runtime.v1.PodSandboxConfig',
    annotations: {
      [`${ANNOTATIONS.ROWDY_IMAGE}`]: 'scaffoldly/rowdy:beta',
      [`${ANNOTATIONS.ROWDY_RUNTIME}`]: 'com.amazonaws.lambda',
    },
    hostname: 'not-implemented',
    labels: {
      [`${LABELS.LAMBDA_MEMORY}`]: '1024',
      [`${LABELS.LAMBDA_TIMEOUT}`]: '900',
      [`${LABELS.ROWDY_RUNTIME}`]: 'com.amazonaws.lambda',
    },
    logDirectory: 'not-implemented',
    metadata: {
      $typeName: 'runtime.v1.PodSandboxMetadata',
      attempt: 0,
      name: 'rowdy',
      namespace: 'not-implemented',
      uid: 'not-implemented',
    },
    portMappings: [],
    linux: {
      $typeName: 'runtime.v1.LinuxPodSandboxConfig',
      cgroupParent: 'not-implemented',
      sysctls: {},
      resources: {
        $typeName: 'runtime.v1.LinuxContainerResources',
        cpuPeriod: BigInt(0),
        cpuQuota: BigInt(0),
        cpuShares: BigInt(0),
        memoryLimitInBytes: BigInt(1024 * 1024 * 1024),
        cpusetCpus: 'not-implemented',
        cpusetMems: 'not-implemented',
        memorySwapLimitInBytes: BigInt(0),
        oomScoreAdj: BigInt(0),
        unified: {},
        hugepageLimits: [],
      },
    },
  };

  private constructor() {}

  static new(): ConfigFactory {
    return new ConfigFactory();
  }

  static fromLambda(
    config?: FunctionConfiguration,
    code?: FunctionCodeLocation,
    tags?: ListTagsResponse
  ): ConfigFactory {
    const factory = new ConfigFactory();
    if (config?.Architectures && config.Architectures[0]) {
      factory._sandboxConfig.labels![LABELS.LAMBDA_ARCHITECTURE] = config.Architectures[0];
    }
    if (config?.ImageConfigResponse?.ImageConfig?.EntryPoint?.[0]) {
      factory._sandboxConfig.labels![LABELS.LAMBDA_ENTRYPOINT] = config.ImageConfigResponse.ImageConfig.EntryPoint[0];
    }
    if (config?.MemorySize) {
      factory._sandboxConfig.linux!.resources!.memoryLimitInBytes = BigInt(config.MemorySize * 1024 * 1024);
      factory._sandboxConfig.labels![LABELS.LAMBDA_MEMORY] = config.MemorySize.toString();
    }
    if (config?.Timeout) {
      factory._sandboxConfig.labels![LABELS.LAMBDA_TIMEOUT] = config.Timeout.toString();
    }
    if (code?.ImageUri) {
      const image = Transfer.normalizeImage(code.ImageUri);
      factory._sandboxConfig.metadata!.name = image.name;
      factory._sandboxConfig.labels![LABELS.ROWDY_IMAGE] = image.name;
    }
    if (tags?.Tags) {
      factory._sandboxConfig.annotations = tags.Tags;
    }
    return factory;
  }

  static fromRequest(req: CRI.RunPodSandboxRequest): ConfigFactory {
    const factory = new ConfigFactory();
    factory._sandboxConfig = { ...factory._sandboxConfig, ...req.config };
    factory._sandboxConfig.metadata = { ...factory._sandboxConfig.metadata!, ...req.config?.metadata };
    factory._sandboxConfig.annotations = {
      ...factory._sandboxConfig.annotations,
      ...req.config?.annotations,
    };
    factory._sandboxConfig.labels = {
      ...factory._sandboxConfig.labels,
      ...req.config?.labels,
    };
    factory._sandboxConfig.linux = { ...factory._sandboxConfig.linux!, ...req.config?.linux };
    factory._sandboxConfig.linux!.resources = {
      ...factory._sandboxConfig.linux!.resources!,
      ...req.config?.linux?.resources,
    };
    return factory;
  }

  withImage(image?: string): this {
    if (!image) {
      return this;
    }
    this._sandboxConfig.metadata!.name = Transfer.normalizeImage(image).name;
    this._sandboxConfig.annotations![ANNOTATIONS.ROWDY_IMAGE] = image;
    return this;
  }

  withMemory(megabytes: number = 1024): this {
    this._sandboxConfig.linux!.resources!.memoryLimitInBytes = BigInt(megabytes * 1024 * 1024);
    this._sandboxConfig.labels![LABELS.LAMBDA_MEMORY] = megabytes.toString();
    return this;
  }

  // get ContainerConfig(): CRI.ContainerConfig {
  //   const name = Transfer.normalizeImage(this._sandboxConfig.annotations![ANNOTATIONS.ROWDY_IMAGE]!).name;
  //   const containerConfig: CRI.ContainerConfig = {
  //     $typeName: 'runtime.v1.ContainerConfig',
  //     annotations: { ...this._sandboxConfig.annotations, [`${ANNOTATIONS.ROWDY_NAME}`]: name },
  //     args: [],
  //     CDIDevices: [],
  //     command: [],
  //     devices: [],
  //     envs: [],
  //     labels: { ...this._sandboxConfig.labels, [`${LABELS.ROWDY_NAME}`]: name },
  //     logPath: 'not-implemented',
  //     mounts: [],
  //     stdin: false,
  //     stdinOnce: false,
  //     stopSignal: CRI.Signal.RUNTIME_DEFAULT,
  //     tty: false,
  //     workingDir: 'not-implemented',
  //     image: {
  //       $typeName: 'runtime.v1.ImageSpec',
  //       annotations: { ...this._sandboxConfig.annotations },
  //       image: this._sandboxConfig.annotations![ANNOTATIONS.ROWDY_IMAGE]!,
  //       runtimeHandler: 'rowdy',
  //       userSpecifiedImage: 'not-implemented',
  //     },
  //     linux: {
  //       $typeName: 'runtime.v1.LinuxContainerConfig',
  //       resources: {
  //         ...this._sandboxConfig.linux!.resources!,
  //       },
  //     },
  //     metadata: {
  //       $typeName: 'runtime.v1.ContainerMetadata',
  //       name,
  //       attempt: 0,
  //     },
  //   };

  //   return containerConfig;
  // }

  get SandboxConfig(): CRI.PodSandboxConfig {
    return this._sandboxConfig;
  }

  get PullImageResponse(): CRI.PullImageResponse {
    const imageRef = this._sandboxConfig.annotations![ANNOTATIONS.ROWDY_IMAGE_REF];
    if (!imageRef) {
      throw new Error('SandboxConfig is missing required annotation for image reference');
    }
    const pullImageResponse: CRI.PullImageResponse = {
      $typeName: 'runtime.v1.PullImageResponse',
      imageRef,
    };
    return pullImageResponse;
  }

  get ImageSpec(): CRI.ImageSpec {
    const image = this._sandboxConfig.annotations![ANNOTATIONS.ROWDY_IMAGE];
    if (!image) {
      throw new Error('SandboxConfig is missing required annotation for image');
    }
    const imageSpec: CRI.ImageSpec = {
      $typeName: 'runtime.v1.ImageSpec',
      annotations: { ...this.SandboxConfig.annotations },
      image,
      runtimeHandler: this.RunPodSandboxRequest.runtimeHandler,
      userSpecifiedImage: 'not-implemented',
    };
    return imageSpec;
  }

  get RunPodSandboxRequest(): CRI.RunPodSandboxRequest {
    const req: CRI.RunPodSandboxRequest = {
      $typeName: 'runtime.v1.RunPodSandboxRequest',
      runtimeHandler: this._sandboxConfig.annotations![ANNOTATIONS.ROWDY_RUNTIME]!,
      config: this.SandboxConfig,
    };
    return req;
  }
}
