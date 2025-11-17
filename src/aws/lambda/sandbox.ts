import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../..';
import { FunctionResource, isSubset } from './function';
import { PolicyDocument } from './iam';
import {
  FunctionConfiguration,
  GetFunctionCommand,
  LambdaClient,
  ListTagsCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionConfigurationRequest,
} from '@aws-sdk/client-lambda';
import { ConfigFactory } from './config';

export class SandboxResource extends FunctionResource {
  static async from(
    environment: Environment,
    id: string
  ): Promise<{ factory: ConfigFactory; sandbox: CRI.PodSandbox }> {
    const client = new LambdaClient({});
    const config = await client.send(new GetFunctionCommand({ FunctionName: id }));
    const tags = await client.send(new ListTagsCommand({ Resource: id }));
    const factory = ConfigFactory.fromLambda(config.Configuration, config.Code, tags);
    const resource = new SandboxResource(environment, factory.RunPodSandboxRequest, factory.ImageSpec).readOnly();
    return { factory, sandbox: await resource.readOnly().Sandbox };
  }

  constructor(
    environment: Environment,
    protected sandbox: CRI.RunPodSandboxRequest,
    image: CRI.ImageSpec
  ) {
    super(environment, image);
  }

  protected override async update(existing: FunctionConfiguration): Promise<FunctionConfiguration> {
    let updated = false;
    if (existing.MemorySize !== this._memorySize || !isSubset(this._variables, existing.Environment?.Variables || {})) {
      existing = await this.lambda.send(
        new UpdateFunctionConfigurationCommand(existing as UpdateFunctionConfigurationRequest)
      );
      updated = true;
    }

    if (updated) {
      // TODO publish new version
    }

    return existing;
  }

  get Sandbox(): PromiseLike<CRI.PodSandbox> {
    return this.retries(10).Resource.then((fn) => {
      if (!fn.FunctionArn) {
        throw new Error('Function ARN is undefined');
      }

      const sandbox: CRI.PodSandbox = {
        $typeName: 'runtime.v1.PodSandbox',
        id: fn.FunctionArn,
        metadata: {
          $typeName: 'runtime.v1.PodSandboxMetadata',
          name: this._metadataName,
          attempt: 0,
          namespace: 'not-implemented',
          uid: 'not-implemented',
        },
        state:
          !fn.LastUpdateStatus || fn.LastUpdateStatus === 'Successful'
            ? CRI.PodSandboxState.SANDBOX_READY
            : CRI.PodSandboxState.SANDBOX_NOTREADY,
        createdAt: BigInt(fn.LastModified ? new Date(fn.LastModified).getTime() : 0),
        labels: this.labels(fn),
        annotations: this.annotations(fn),
        runtimeHandler: this._runtimeHandler,
      };
      return sandbox;
    });
  }

  override get policyDocument(): PolicyDocument {
    return {
      Version: '2012-10-17',
      Statement: [
        ...super.policyDocument.Statement,
        {
          Effect: 'Allow',
          Action: [
            'ecr:*',
            'lambda:*',
            'iam:CreateRole',
            'iam:GetRole',
            'iam:GetRolePolicy',
            'iam:PassRole',
            'iam:PutRolePolicy',
            'iam:UpdateAssumeRolePolicy',
            'scheduler:CreateSchedule',
            'scheduler:CreateScheduleGroup',
            'scheduler:DeleteSchedule',
            'scheduler:GetScheduleGroup',
            'scheduler:ListSchedules',
            'scheduler:UpdateSchedule',
            'secretsmanager:CreateSecret',
            'secretsmanager:DescribeSecret',
            'secretsmanager:PutSecretValue',
          ],
          Resource: ['*'],
        },
      ],
    };
  }

  protected override get _type(): 'Sandbox' | 'Container' {
    return 'Sandbox';
  }

  protected override get _metadataName(): string {
    return this.sandbox.config?.metadata?.name || ConfigFactory.new().SandboxConfig!.metadata!.name!;
  }

  protected override get _runtimeHandler(): string {
    return this.sandbox.runtimeHandler || ConfigFactory.new().RuntimeHandler;
  }

  protected override get _memoryLimitInBytes(): bigint {
    return (
      this.sandbox.config?.linux?.resources?.memoryLimitInBytes ||
      ConfigFactory.new().SandboxConfig!.linux!.resources!.memoryLimitInBytes!
    );
  }

  protected override get _annotations(): Record<string, string> {
    return this.sandbox.config?.annotations || ConfigFactory.new().SandboxConfig!.annotations!;
  }

  protected override get _labels(): Record<string, string> {
    return this.sandbox.config?.labels || ConfigFactory.new().SandboxConfig!.labels!;
  }
}
