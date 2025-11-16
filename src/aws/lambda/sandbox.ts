import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../..';
import { ConfigFactory, FunctionResource } from './function';
import { PolicyDocument } from './iam';
import { GetFunctionCommand, LambdaClient, ListTagsCommand } from '@aws-sdk/client-lambda';

export class SandboxResource extends FunctionResource {
  static async from(environment: Environment, id: string): Promise<CRI.PodSandbox> {
    const client = new LambdaClient({});
    const config = await client.send(new GetFunctionCommand({ FunctionName: id }));
    const tags = await client.send(new ListTagsCommand({ Resource: id }));
    const factory = ConfigFactory.fromLambda(config.Configuration, config.Code, tags);
    const resource = new SandboxResource(environment, factory.RunPodSandboxRequest, factory.PullImageResponse);
    return resource.Sandbox;
  }

  constructor(
    environment: Environment,
    protected sandbox: CRI.RunPodSandboxRequest,
    image: CRI.PullImageResponse
  ) {
    super(environment, image);
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
