import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../..';
import { FunctionResource } from './function';
import { ConfigFactory, LABELS } from './config';
import {
  FunctionConfiguration,
  UpdateFunctionCodeCommand,
  CreateAliasCommand,
  AliasConfiguration,
  GetAliasCommandOutput,
  LambdaClient,
  GetAliasCommand,
  UpdateAliasCommand,
  DeleteAliasCommand,
  GetFunctionCommand,
  ListTagsCommand,
} from '@aws-sdk/client-lambda';
import { CloudResource } from '@scaffoldly/rowdy-cdk';

export class ContainerResource extends FunctionResource {
  static async from(
    environment: Environment,
    sandbox: CRI.PodSandbox,
    id: string
  ): Promise<{ factory: ConfigFactory; container: CRI.Container }> {
    const client = new LambdaClient({});
    const config = await client.send(new GetFunctionCommand({ FunctionName: id }));
    const tags = await client.send(new ListTagsCommand({ Resource: sandbox.id }));
    const factory = ConfigFactory.fromLambda(config.Configuration, config.Code, tags);
    const resource = new ContainerResource(environment, sandbox, factory.CreateContainerRequest, factory.ImageSpec);
    return { factory, container: await resource.readOnly().Container };
  }

  private _alias: AliasResource;
  private _configuration?: FunctionConfiguration;
  private _id?: string;

  constructor(
    environment: Environment,
    protected sandbox: CRI.PodSandbox,
    protected container: CRI.CreateContainerRequest,
    image: CRI.ImageSpec
  ) {
    super(environment, image);
    this._alias = new AliasResource(this, image);
  }

  protected override async update(existing: FunctionConfiguration): Promise<FunctionConfiguration> {
    // TODO update environment variables
    // TODO create function URL

    if (existing.CodeSha256 !== this._codeSha256) {
      existing = await this.lambda.send(
        new UpdateFunctionCodeCommand({
          FunctionName: this.sandbox.id,
          ImageUri: this.image?.image,
          Publish: true,
        })
      );
    }

    this._configuration = existing;
    return existing;
  }

  get Container(): PromiseLike<CRI.Container> {
    return this.Id.then((id) => {
      const image = this.image?.image;
      if (!image) {
        throw new Error('Image is undefined');
      }

      const container: CRI.Container = {
        $typeName: 'runtime.v1.Container',
        id,
        annotations: this._annotations,
        createdAt: BigInt(0), // TODO
        imageId: 'not-implemented',
        imageRef: image,
        labels: this._labels,
        podSandboxId: this.sandbox.id,
        state: CRI.ContainerState.CONTAINER_CREATED,
      };

      return container;
    });
  }

  get FunctionArn(): PromiseLike<string> {
    return this.Resource.then((r) => r.FunctionArn!);
  }

  get FunctionVersion(): PromiseLike<string> {
    return this.Resource.then((r) => r.Version!);
  }

  get Id(): PromiseLike<string> {
    if (this._id) {
      return Promise.resolve(this._id);
    }
    return this._alias.Id.then((id) => (this._id = id));
  }

  protected override get _type(): 'Sandbox' | 'Container' {
    return 'Container';
  }

  protected override get _metadataName(): string {
    return (
      this.container.config?.metadata?.name ||
      this.container.sandboxConfig?.metadata?.name ||
      this.sandbox.metadata!.name!
    );
  }

  protected override get _annotations(): Record<string, string> {
    return {
      ...this.sandbox.annotations,
      ...this.container.config?.annotations,
      ...this.container.sandboxConfig?.annotations,
    };
  }

  protected override get _labels(): Record<string, string> {
    return {
      ...this.sandbox.labels,
      ...this.container.config?.labels,
      ...this.container.sandboxConfig?.labels,
    };
  }

  protected override get _memoryLimitInBytes(): bigint {
    return (
      this.container.config?.linux?.resources?.memoryLimitInBytes ||
      this.container.sandboxConfig?.linux?.resources?.memoryLimitInBytes ||
      BigInt(parseInt(this.sandbox.labels![LABELS.LAMBDA_MEMORY]!) * 1024 * 1024)
    );
  }

  protected override get _runtimeHandler(): string {
    return this.container.config?.image?.runtimeHandler || this.sandbox.runtimeHandler!;
  }
}

class AliasResource extends CloudResource<AliasConfiguration, GetAliasCommandOutput> {
  private lambda = new LambdaClient({});
  private _id?: string;

  constructor(
    container: ContainerResource,
    private image: CRI.ImageSpec
  ) {
    super(
      {
        describe: () => ({ type: 'Function Alias', label: this._name }),
        read: async () =>
          this.lambda.send(new GetAliasCommand({ FunctionName: await container.FunctionName, Name: this._name })),
        create: async () => {
          return this.lambda.send(
            new CreateAliasCommand({
              FunctionName: await container.FunctionName,
              Name: this._name,
              FunctionVersion: await container.FunctionVersion,
            })
          );
        },
        update: async () => {
          return this.lambda.send(
            new UpdateAliasCommand({
              FunctionName: await container.FunctionName,
              Name: this._name,
              FunctionVersion: await container.FunctionVersion,
            })
          );
        },
        dispose: async (_resource) =>
          this.lambda.send(new DeleteAliasCommand({ FunctionName: await container.FunctionName, Name: this._name })),
      },
      (output) => output as AliasConfiguration
    );
  }

  get _name(): string {
    const sha256 = this.image.image.split('@sha256:')[1];
    if (!sha256) {
      throw new Error(`Invalid image: ${this.image.image}`);
    }
    return sha256.substring(0, 12);
  }

  get Id(): PromiseLike<string> {
    if (this._id) {
      return Promise.resolve(this._id);
    }
    return this.Resource.then((r) => (this._id = r.AliasArn!));
  }
}
