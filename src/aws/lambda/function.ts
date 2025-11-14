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
    return this.iamRole.RoleId.then((roleId) => `${this.req.runtimeHandler}_${roleId}`);
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
        labels: {
          entrypoint: fn.ImageConfigResponse?.ImageConfig?.EntryPoint?.[0] ?? 'unknown',
          architecture: fn.Architectures?.[0] ?? 'unknown',
          memory: fn.MemorySize?.toString() ?? 'unknown',
        },
        annotations: {
          'aws.lambda.arn': fn.FunctionArn ?? '',
          'aws.lambda.version': fn.Version ?? '',
          'aws.lambda.lastModified': fn.LastModified ?? '',
          'aws.lambda.role': fn.Role ?? '',
          'aws.lambda.timeout': fn.Timeout?.toString() ?? '',
          'aws.lambda.codeSha256': fn.CodeSha256 ?? '',
          'aws.lambda.revisionId': fn.RevisionId ?? '',
          'aws.lambda.lastUpdateStatus': fn.LastUpdateStatus ?? '',
          'aws.lambda.lastUpdateStatusReason': fn.LastUpdateStatusReason ?? '',
        },
        runtimeHandler: 'aws.lambda',
      };
      return sandbox;
    });
  }

  constructor(
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

          if (existing.MemorySize !== this._memorySize) {
            existing = await this.lambda.send(
              new UpdateFunctionConfigurationCommand(existing as UpdateFunctionConfigurationRequest)
            );
          }

          return existing;
        },
        dispose: async () => this.lambda.send(new DeleteFunctionCommand({ FunctionName: await this._functionName })),
        emitPermissions: (aware) => {
          aware.withPermissions([
            'lambda:CreateFunction',
            'lambda:GetFunction',
            'lambda:UpdateFunctionConfiguration',
            'lambda:ListEventSourceMappings',
            'lambda:CreateEventSourceMapping',
            'lambda:UpdateEventSourceMapping',
            'lambda:DeleteEventSourceMapping',
          ]);
        },
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
  private _containerConfig: CRI.ContainerConfig = {
    $typeName: 'runtime.v1.ContainerConfig',
    annotations: {
      'run.rowdy.image': `scaffoldly/rowdy:beta`,
    },
    args: [],
    CDIDevices: [],
    command: [],
    devices: [],
    envs: [],
    image: {
      $typeName: 'runtime.v1.ImageSpec',
      annotations: {
        'run.rowdy.image': `scaffoldly/rowdy:beta`,
      },
      image: `scaffoldly/rowdy:beta`,
      runtimeHandler: 'rowdy',
      userSpecifiedImage: 'not-implemented',
    },
    labels: {},
    linux: {
      $typeName: 'runtime.v1.LinuxContainerConfig',
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
    logPath: 'not-implemented',
    mounts: [],
    stdin: false,
    stdinOnce: false,
    stopSignal: CRI.Signal.RUNTIME_DEFAULT,
    tty: false,
    workingDir: 'not-implemented',
  };

  private constructor() {}

  static new(): ConfigFactory {
    return new ConfigFactory();
  }

  static from(req: CRI.RunPodSandboxRequest): ConfigFactory {
    const factory = new ConfigFactory();
    factory._containerConfig.annotations = { ...factory._containerConfig.annotations, ...req.config?.annotations };
    factory._containerConfig.labels = { ...factory._containerConfig.labels, ...req.config?.labels };
    factory._containerConfig.image!.runtimeHandler =
      req.runtimeHandler || factory._containerConfig.image!.runtimeHandler;
    return factory;
  }

  withImage(image?: string): this {
    if (!image) {
      return this;
    }

    this._containerConfig.image = {
      ...this._containerConfig.image!,
      image,
    };

    this._containerConfig.image!.annotations!['run.rowdy.image'] = image;
    this._containerConfig.annotations!['run.rowdy.image'] = image;

    return this;
  }

  withMemory(megabytes: number = 1024): this {
    this._containerConfig.linux!.resources!.memoryLimitInBytes = BigInt(megabytes * 1024 * 1024);
    this._containerConfig.labels!['memory'] = megabytes.toString();
    return this;
  }

  get ContainerConfig(): CRI.ContainerConfig {
    const containerConfig: CRI.ContainerConfig = {
      ...this._containerConfig,
    };

    containerConfig.linux!.resources!.memoryLimitInBytes = this._containerConfig.labels!['memory']
      ? BigInt(Number(this._containerConfig.labels!['memory']) * 1024 * 1024)
      : containerConfig.linux!.resources!.memoryLimitInBytes;

    return containerConfig;
  }

  get SandboxConfig(): CRI.PodSandboxConfig {
    const sandboxConfig: CRI.PodSandboxConfig = {
      $typeName: 'runtime.v1.PodSandboxConfig',
      annotations: { ...this.ContainerConfig.annotations },
      hostname: 'not-implemented',
      labels: { ...this.ContainerConfig.labels },
      logDirectory: 'not-implemented',
      portMappings: [],
      linux: {
        $typeName: 'runtime.v1.LinuxPodSandboxConfig',
        cgroupParent: 'not-implemented',
        sysctls: {},
        resources: {
          ...this.ContainerConfig.linux!.resources!,
        },
      },
    };

    return sandboxConfig;
  }

  get PullImageResponse(): CRI.PullImageResponse {
    const pullImageResponse: CRI.PullImageResponse = {
      $typeName: 'runtime.v1.PullImageResponse',
      imageRef: this._containerConfig!.image!.image,
    };
    return pullImageResponse;
  }

  get ImageSpec(): CRI.ImageSpec {
    return this.ContainerConfig.image!;
  }

  get RunPodSandboxRequest(): CRI.RunPodSandboxRequest {
    const req: CRI.RunPodSandboxRequest = {
      $typeName: 'runtime.v1.RunPodSandboxRequest',
      runtimeHandler: this.ContainerConfig.image!.runtimeHandler!,
      config: this.SandboxConfig,
    };
    return req;
  }

  get RuntimeHandler(): string {
    return this.ContainerConfig.image!.runtimeHandler!;
  }
}
