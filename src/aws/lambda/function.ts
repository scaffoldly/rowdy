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

  get _tags(): Record<string, string> {
    return {
      ...this.req.config?.labels,
      ...this.req.config?.annotations,
    };
  }

  annotations = (fn: FunctionConfiguration): Record<string, string> => {
    return {
      'com.amazonaws.lambda.arn': fn.FunctionArn ?? '',
      'com.amazonaws.lambda.version': fn.Version ?? '',
      'com.amazonaws.lambda.lastModified': fn.LastModified ?? '',
      'com.amazonaws.lambda.role': fn.Role ?? '',
      'com.amazonaws.lambda.timeout': fn.Timeout?.toString() ?? '',
      'com.amazonaws.lambda.codeSha256': fn.CodeSha256 ?? '',
      'com.amazonaws.lambda.revisionId': fn.RevisionId ?? '',
      'com.amazonaws.lambda.lastUpdateStatus': fn.LastUpdateStatus ?? '',
      'com.amazonaws.lambda.lastUpdateStatusReason': fn.LastUpdateStatusReason ?? '',
    };
  };

  labels = (fn: FunctionConfiguration): Record<string, string> => {
    return {
      entrypoint: fn.ImageConfigResponse?.ImageConfig?.EntryPoint?.[0] ?? 'unknown',
      architecture: fn.Architectures?.[0] ?? 'unknown',
      memory: fn.MemorySize?.toString() ?? 'unknown',
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
          !fn.LastUpdateStatus || fn.LastUpdateStatus !== 'Successful'
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
        describe: (config) => ({ type: 'Lambda Function', label: config.FunctionArn || '[new]' }),
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
              Tags: this._tags,
            })
          ),
        update: async (existing) => {
          if (existing.CodeSha256 !== this._codeSha256) {
            existing = await this.lambda.send(
              new UpdateFunctionCodeCommand({
                FunctionName: await this._functionName,
                ImageUri: this.image.imageRef,
                Publish: false,
              })
            );
          }

          if (
            existing.MemorySize !== this._memorySize ||
            !isSubset(this._variables, existing.Environment?.Variables || {})
          ) {
            existing = await this.lambda.send(
              new UpdateFunctionConfigurationCommand(existing as UpdateFunctionConfigurationRequest)
            );
          }

          return existing;
        },
        dispose: async () => this.lambda.send(new DeleteFunctionCommand({ FunctionName: await this._functionName })),
      },
      (output) => {
        return output.Configuration || {};
      }
    );

    this.iamRole = new IamRoleResource(image).withConsumer(this);
  }

  // static async fromContainerId(id: string): Promise<CRI.PodSandbox> {
  //   const resource = new SandboxResource(
  //     {
  //       $typeName: 'runtime.v1.CreateContainerRequest',
  //       podSandboxId: id,
  //     },
  //     { $typeName: 'runtime.v1.PullImageResponse', imageRef: '' }
  //   );

  //   const config = await resource.lambda.send(new GetFunctionCommand({ FunctionName: id }));
  //   const factory = ConfigFactory.new().withImage(config.Code?.ImageUri).withMemory(config.Configuration?.MemorySize);

  //   resource.req = {
  //     $typeName: 'runtime.v1.CreateContainerRequest',
  //     podSandboxId: id,
  //     config: factory.ContainerConfig,
  //     sandboxConfig: factory.SandboxConfig,
  //   };
  //   resource.image = factory.PullImageResponse;

  //   return resource.Sandbox;
  // }

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
      'run.rowdy.image': `scaffoldly/rowdy:beta`,
      'run.rowdy.runtime': 'com.amazonaws.lambda',
    },
    hostname: 'not-implemented',
    labels: {
      'com.amazonaws.lambda.memory': '1024',
      'com.amazonaws.lambda.timeout': '900',
      'run.rowdy.runtime': 'com.amazonaws.lambda',
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

  static from(req: CRI.RunPodSandboxRequest): ConfigFactory {
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
    this._sandboxConfig.annotations!['run.rowdy.image'] = image;
    return this;
  }

  withMemory(megabytes: number = 1024): this {
    this._sandboxConfig.linux!.resources!.memoryLimitInBytes = BigInt(megabytes * 1024 * 1024);
    this._sandboxConfig.labels!['aws.lambda.memory'] = megabytes.toString();
    return this;
  }

  get ContainerConfig(): CRI.ContainerConfig {
    const name = Transfer.normalizeImage(this._sandboxConfig.annotations!['run.rowdy.image']!).name;
    const containerConfig: CRI.ContainerConfig = {
      $typeName: 'runtime.v1.ContainerConfig',
      annotations: { ...this._sandboxConfig.annotations, 'run.rowdy.name': name },
      args: [],
      CDIDevices: [],
      command: [],
      devices: [],
      envs: [],
      labels: { ...this._sandboxConfig.labels },
      logPath: 'not-implemented',
      mounts: [],
      stdin: false,
      stdinOnce: false,
      stopSignal: CRI.Signal.RUNTIME_DEFAULT,
      tty: false,
      workingDir: 'not-implemented',
      image: {
        $typeName: 'runtime.v1.ImageSpec',
        annotations: { ...this._sandboxConfig.annotations },
        image: this._sandboxConfig.annotations!['run.rowdy.image']!,
        runtimeHandler: 'rowdy',
        userSpecifiedImage: 'not-implemented',
      },
      linux: {
        $typeName: 'runtime.v1.LinuxContainerConfig',
        resources: {
          ...this._sandboxConfig.linux!.resources!,
        },
      },
      metadata: {
        $typeName: 'runtime.v1.ContainerMetadata',
        name,
        attempt: 0,
      },
    };

    return containerConfig;
  }

  get SandboxConfig(): CRI.PodSandboxConfig {
    return this._sandboxConfig;
  }

  get PullImageResponse(): CRI.PullImageResponse {
    const pullImageResponse: CRI.PullImageResponse = {
      $typeName: 'runtime.v1.PullImageResponse',
      imageRef: this.ContainerConfig.image!.image!,
    };
    return pullImageResponse;
  }

  get ImageSpec(): CRI.ImageSpec {
    return this.ContainerConfig.image!;
  }

  get RunPodSandboxRequest(): CRI.RunPodSandboxRequest {
    const req: CRI.RunPodSandboxRequest = {
      $typeName: 'runtime.v1.RunPodSandboxRequest',
      runtimeHandler: this._sandboxConfig.annotations!['run.rowdy.runtime']!,
      config: this.SandboxConfig,
    };
    return req;
  }
}
