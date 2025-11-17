import {
  DeleteFunctionCommand,
  FunctionConfiguration,
  GetFunctionCommand,
  GetFunctionCommandOutput,
  LambdaClient,
  TagResourceCommand,
  ListTagsCommand,
  CreateFunctionCommand,
} from '@aws-sdk/client-lambda';
import { CloudResource } from '@scaffoldly/rowdy-cdk';
import { IamConsumer, IamRoleResource, PolicyDocument, TrustRelationship } from './iam';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../..';
import { ANNOTATIONS, LABELS } from './config';

export const isSubset = (subset: Record<string, string>, superset: Record<string, string>): boolean => {
  for (const key of Object.keys(subset)) {
    if (superset[key] !== subset[key]) {
      return false;
    }
  }
  return true;
};

export abstract class FunctionResource
  extends CloudResource<FunctionConfiguration, GetFunctionCommandOutput>
  implements IamConsumer
{
  protected lambda = new LambdaClient({});
  private iamRole: IamRoleResource;

  constructor(
    public readonly environment: Environment,
    protected image?: CRI.ImageSpec
  ) {
    super(
      {
        describe: (config) => ({ type: `${this._type} Function`, label: config.FunctionName }),
        read: async () =>
          this.lambda.send(
            new GetFunctionCommand({
              FunctionName: await this.FunctionName,
            })
          ),
        create: async () =>
          this.lambda.send(
            new CreateFunctionCommand({
              FunctionName: await this.FunctionName,
              Role: await this.RoleArn,
              PackageType: 'Image',
              // TODO: Support for platform annotation
              Architectures: ['x86_64'],
              Timeout: 900,
              MemorySize: this._memorySize,
              Publish: false,
              Code: { ImageUri: this.image?.image },
              ImageConfig: { EntryPoint: ['rowdy'] },
              Environment: {
                Variables: this._variables,
              },
              // TODO: Update tags if changed
              Tags: { ...this.Tags },
            })
          ),
        update: (existing) => this.update(existing),
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
        dispose: async () => this.lambda.send(new DeleteFunctionCommand({ FunctionName: await this.FunctionName })),
      },
      (output) => {
        return output.Configuration || {};
      }
    );

    this.iamRole = new IamRoleResource(image).withConsumer(this);
  }

  protected abstract update(existing: FunctionConfiguration): Promise<FunctionConfiguration>;
  protected abstract get _type(): 'Sandbox' | 'Container';
  protected abstract get _metadataName(): string;
  protected abstract get _annotations(): Record<string, string>;
  protected abstract get _labels(): Record<string, string>;
  protected abstract get _memoryLimitInBytes(): bigint;
  protected abstract get _runtimeHandler(): string;

  get RoleArn(): PromiseLike<string> {
    return this.iamRole.RoleArn;
  }

  get FunctionName(): PromiseLike<string> {
    return this.iamRole.RoleId.then((roleId) => `${this._metadataName}_${roleId}`);
  }

  protected get _codeSha256(): string {
    const sha256 = this.image?.image?.split('@sha256:')[1];
    if (!sha256) {
      throw new Error('Image reference does not contain sha256 digest');
    }
    return sha256;
  }

  protected get _memorySize(): number {
    const desired = this._memoryLimitInBytes;
    if (!desired) {
      return 1024;
    }
    return Number(desired) / 1024 / 1024;
  }

  get _registry(): string {
    const registry = this.image?.image?.split('/')[0];
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
      ...this.Tags,
      [`${ANNOTATIONS.LAMBDA_ARN}`]: fn.FunctionArn ?? '',
      [`${ANNOTATIONS.LAMBDA_VERSION}`]: fn.Version?.replace('$', '') ?? '',
      [`${ANNOTATIONS.LAMBDA_ROLE}`]: fn.Role ?? '',
      [`${ANNOTATIONS.LAMBDA_TIMEOUT}`]: fn.Timeout?.toString() ?? '',
      [`${ANNOTATIONS.LAMBDA_CODE_SHA256}`]: fn.CodeSha256 ?? '',
      [`${ANNOTATIONS.LAMBDA_REVISION_ID}`]: fn.RevisionId ?? '',
      [`${ANNOTATIONS.ROWDY_RUNTIME}`]: this._annotations?.[`${ANNOTATIONS.ROWDY_RUNTIME}`] ?? '',
      [`${ANNOTATIONS.ROWDY_IMAGE}`]: this._annotations?.[`${ANNOTATIONS.ROWDY_IMAGE}`] ?? '',
      [`${ANNOTATIONS.ROWDY_IMAGE_REF}`]: this.image?.image ?? '',
    };
  };

  labels = (fn: FunctionConfiguration): Record<string, string> => {
    return {
      [`${LABELS.LAMBDA_ENTRYPOINT}`]: fn.ImageConfigResponse?.ImageConfig?.EntryPoint?.[0] ?? '',
      [`${LABELS.LAMBDA_ARCHITECTURE}`]: fn.Architectures?.[0] ?? '',
      [`${LABELS.LAMBDA_MEMORY}`]: fn.MemorySize?.toString() ?? '',
      [`${LABELS.LAMBDA_TIMEOUT}`]: fn.Timeout?.toString() ?? '',
      [`${LABELS.ROWDY_RUNTIME}`]: this._labels?.[`${LABELS.ROWDY_RUNTIME}`] ?? '',
      [`${LABELS.ROWDY_IMAGE}`]: this._labels?.[`${LABELS.ROWDY_IMAGE}`] ?? '',
    };
  };

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
            // Standard Execution Actions
            'logs:CreateLogStream',
            'logs:CreateLogGroup',
            'logs:TagResource',
            'logs:PutLogEvents',
            'xray:PutTraceSegments',
            'xray:PutTelemetryRecords',
            'ec2:CreateNetworkInterface',
            'ec2:DescribeNetworkInterfaces',
            'ec2:DescribeSubnets',
            'ec2:DeleteNetworkInterface',
            'ec2:AssignPrivateIpAddresses',
            'ec2:UnassignPrivateIpAddresses',
          ],
          Resource: ['*'],
          Effect: 'Allow',
        },
      ],
    };
  }
}
