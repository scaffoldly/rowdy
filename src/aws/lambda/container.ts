import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../..';
import { FunctionResource } from './function';
import { ConfigFactory, LABELS, TAGS } from './config';
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
  FunctionUrlConfig,
  GetFunctionUrlConfigCommandOutput,
  GetFunctionUrlConfigCommand,
  CreateFunctionUrlConfigCommand,
  UpdateFunctionUrlConfigCommand,
  DeleteFunctionUrlConfigCommand,
} from '@aws-sdk/client-lambda';
import { CloudResource } from '@scaffoldly/rowdy-cdk';

export const environmental = (tags: Record<string, string>): Record<string, string> => {
  return Object.entries(tags).reduce(
    (env, [key, value]) => {
      env[
        `${key
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .replace(/[^A-Za-z0-9]+/g, '_')
          .toUpperCase()}`
      ] = value;
      return env;
    },
    {} as Record<string, string>
  );
};

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

  private _configuration?: FunctionConfiguration;
  private _alias: AliasResource;
  private _id?: string;

  constructor(
    environment: Environment,
    protected sandbox: CRI.PodSandbox,
    protected container: CRI.CreateContainerRequest,
    image: CRI.ImageSpec
  ) {
    super(environment, image);
    this._alias = new AliasResource(this, image).retries(10);
  }

  protected override async update(existing: FunctionConfiguration): Promise<FunctionConfiguration> {
    await this._alias.manage();
    await this._alias.Url;
    // const { Tags = {} } = await this.lambda.send(new ListTagsCommand({ Resource: this.sandbox.id }));

    // if (!Tags[TAGS.LAMBDA_URL] || Tags[TAGS.LAMBDA_URL] !== url) {
    //   Tags[TAGS.LAMBDA_URL] = url;
    //   await this.lambda.send(
    //     new TagResourceCommand({
    //       Resource: this.sandbox.id,
    //       Tags,
    //     })
    //   );
    // }

    // const env = {
    //   ...environmental(existing.Environment?.Variables || {}),
    //   ...environmental(this._variables),
    //   ...environmental(this.annotations(existing)),
    //   ...environmental(Tags),
    // };

    // console.log('!!! desired env', env);
    // console.log('!!! existing env', existing.Environment?.Variables);
    // console.log('!!! isSubset', isSubset(env, existing.Environment?.Variables || {}));

    // if (!isSubset(env, existing.Environment?.Variables || {})) {
    //   // Update the sandbox with the updated environment
    //   existing = await this.lambda.send(
    //     new UpdateFunctionConfigurationCommand({
    //       ...(existing as UpdateFunctionConfigurationCommandInput),
    //       FunctionName: this.sandbox.id,
    //       Environment: { Variables: env },
    //     })
    //   );
    //   // Re-manage to re-alias with new version / env
    //   // return this.manage();
    //   return existing;
    // }

    return existing;
  }

  get Container(): PromiseLike<CRI.Container> {
    return this.retries(10)
      .Resource.then(() => this._alias.Id)
      .then((id) => {
        const image = this.image?.image;
        if (!image) {
          throw new Error('Image is undefined');
        }

        const container: CRI.Container = {
          $typeName: 'runtime.v1.Container',
          id,
          annotations: this._annotations,
          createdAt: BigInt(0), // not-implemented
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
    if (this._configuration && !!this._configuration.FunctionArn) {
      return Promise.resolve(this._configuration.FunctionArn);
    }
    return this.manage().then(() => this.FunctionArn);
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
  private _url: UrlResource;

  constructor(
    container: ContainerResource,
    private image: CRI.ImageSpec
  ) {
    super(
      {
        describe: () => ({ type: 'Function Alias', label: this.Name }),
        read: async () =>
          this.lambda.send(new GetAliasCommand({ FunctionName: await container.FunctionName, Name: this.Name })),
        create: async () =>
          this.lambda
            .send(
              new UpdateFunctionCodeCommand({
                FunctionName: await container.FunctionName,
                ImageUri: this.image.image,
                Publish: true,
              })
            )
            .then((config) =>
              this.lambda.send(
                new CreateAliasCommand({
                  FunctionName: config.FunctionName,
                  Name: this.Name,
                  FunctionVersion: config.Version,
                })
              )
            ),
        update: async () =>
          this.lambda
            .send(
              new UpdateFunctionCodeCommand({
                FunctionName: await container.FunctionName,
                ImageUri: this.image.image,
                Publish: true,
              })
            )
            .then((config) =>
              this.lambda.send(
                new UpdateAliasCommand({
                  FunctionName: config.FunctionName,
                  Name: this.Name,
                  FunctionVersion: config.Version,
                })
              )
            ),
        dispose: async (_resource) =>
          this.lambda.send(new DeleteAliasCommand({ FunctionName: await container.FunctionName, Name: this.Name })),
      },
      (output) => output as AliasConfiguration
    );

    this._url = new UrlResource(container, this);
  }

  get Id(): PromiseLike<string> {
    return this.Resource.then((r) => this._url.Url.then(() => r.AliasArn!));
  }

  get Version(): PromiseLike<string> {
    return this.Resource.then((r) => this._url.Url.then(() => r.FunctionVersion!));
  }

  get Url(): PromiseLike<string> {
    return this.Resource.then(() => this._url.Url);
  }

  get Name(): string {
    const sha256 = this.image.image.split('@sha256:')[1];
    if (!sha256) {
      throw new Error(`Invalid image: ${this.image.image}`);
    }
    return sha256.substring(0, 12);
  }
}

class UrlResource extends CloudResource<FunctionUrlConfig, GetFunctionUrlConfigCommandOutput> {
  private lambda = new LambdaClient({});

  constructor(
    private container: ContainerResource,
    private alias: AliasResource
  ) {
    super(
      {
        describe: (url) => ({ type: 'Function URL', label: url.FunctionUrl }),
        read: async () =>
          this.lambda.send(
            new GetFunctionUrlConfigCommand({
              FunctionName: await container.FunctionName,
              Qualifier: await this.Alias,
            })
          ),
        create: async () =>
          this.lambda.send(
            new CreateFunctionUrlConfigCommand({
              FunctionName: await container.FunctionName,
              AuthType: 'NONE',
              Cors: {
                AllowCredentials: true,
                AllowHeaders: ['*'],
                AllowMethods: ['*'],
                AllowOrigins: ['*'],
                MaxAge: 3600,
              },
              InvokeMode: 'RESPONSE_STREAM',
              Qualifier: await this.Alias,
            })
          ),
        update: async () =>
          this.lambda.send(
            new UpdateFunctionUrlConfigCommand({
              FunctionName: await container.FunctionName,
              AuthType: 'NONE',
              Cors: {
                AllowCredentials: true,
                AllowHeaders: ['*'],
                AllowMethods: ['*'],
                AllowOrigins: ['*'],
                MaxAge: 3600,
              },
              InvokeMode: 'RESPONSE_STREAM',
              Qualifier: alias.Name,
            })
          ),
        dispose: async (_resource) =>
          this.lambda.send(new DeleteFunctionUrlConfigCommand({ FunctionName: await container.FunctionName })),
      },
      (output) => output as FunctionUrlConfig
    );
  }

  get Alias(): PromiseLike<string> {
    return this.alias.Resource.then((r) => r.Name!);
  }

  get Url(): PromiseLike<string> {
    return this.Resource.then((r) => {
      this.container.withTag(TAGS.LAMBDA_URL, r.FunctionUrl!);
      return r.FunctionUrl!;
    });
  }
}
