import { MetadataBearer, Logger } from '@smithy/types';
import { CreateRoleCommand, GetRoleCommand, IAMClient, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import {
  AddPermissionCommand,
  CreateAliasCommand,
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  GetAliasCommand,
  GetFunctionUrlConfigCommand,
  LambdaClient,
  UpdateAliasCommand,
  UpdateFunctionCodeCommand,
  GetFunctionCommand,
  GetPolicyCommand,
  UpdateFunctionCodeCommandInput,
  UpdateFunctionConfigurationCommandInput,
  UpdateFunctionConfigurationCommand,
  ListTagsCommand,
  TagResourceCommandInput,
  TagResourceCommand,
  PublishVersionCommand,
  GetFunctionConfigurationCommand,
  GetFunctionConfigurationCommandOutput,
} from '@aws-sdk/client-lambda';
import { PolicyDocument } from 'aws-lambda';
import { ILoggable } from '../../log';
import { LambdaImageService } from './image';
import { Image, Transfer } from '../../api/internal/transfer';
import {
  AsyncSubject,
  BehaviorSubject,
  combineLatest,
  concatMap,
  defer,
  map,
  merge,
  Observable,
  OperatorFunction,
  ReplaySubject,
  retry,
  shareReplay,
  switchMap,
  take,
  tap,
} from 'rxjs';

export const isSubset = (subset: Record<string, string>, superset: Record<string, string>): boolean => {
  for (const key of Object.keys(subset)) {
    if (superset[key] !== subset[key]) {
      return false;
    }
  }
  return true;
};

const _create = <T>(read: () => Promise<T>, write: () => Promise<unknown>, cb?: (res: T) => void): Observable<T> => {
  return defer(() =>
    read().catch((err) => {
      throw err;
    })
  )
    .pipe(
      retry({
        delay: () =>
          write().catch((err) => {
            throw err;
          }),
      })
    )
    .pipe(tap((res) => cb?.(res)));
};

const pullImage = (lambda: LambdaFunction): OperatorFunction<{ requested: string; normalized: Image }, string> => {
  return (source) =>
    source.pipe(
      switchMap(({ requested }) => {
        return lambda.imageService.pullImage({
          $typeName: 'runtime.v1.PullImageRequest',
          image: {
            $typeName: 'runtime.v1.ImageSpec',
            image: requested,
            annotations: {},
            runtimeHandler: '',
            userSpecifiedImage: '',
          },
        });
      }),
      map(({ imageRef }) => imageRef)
    );
};

const aliasImage = (): OperatorFunction<{ requested: string; normalized: Image }, string> => {
  return (source) => source.pipe(map(({ normalized }) => normalized.tag || normalized.digest));
};

export class LambdaFunction
  // extends CloudResource<Resources, LambdaFunction>
  implements ILoggable, Logger
{
  private iam = new IAMClient({ logger: this });
  private lambda = new LambdaClient({ logger: this });

  private type: 'Sandbox' | 'Container';

  // Reactive Properties
  private Image: BehaviorSubject<{ requested: string; normalized: Image }> = new BehaviorSubject({
    requested: 'scaffoldly/rowdy:beta',
    normalized: Transfer.normalizeImage('scaffoldly/rowdy:beta'),
  });
  private MemorySize: BehaviorSubject<number> = new BehaviorSubject(128);
  private Environment: BehaviorSubject<Record<string, string>> = new BehaviorSubject({});
  private Tags: BehaviorSubject<Record<string, string>> = new BehaviorSubject({});

  // Resource Properties
  private RoleName = new ReplaySubject<string>(1);
  private RoleArn = new ReplaySubject<string>(1);
  private FunctionName = new ReplaySubject<string>(1);
  private FunctionArn = new ReplaySubject<string>(1);
  private FunctionVersion = new ReplaySubject<string>(1);
  private FunctionQualifier = new ReplaySubject<string>(1);
  private FunctionUrl = new ReplaySubject<string>(1);

  // Derived Properties
  private ImageRef = this.Image.pipe(pullImage(this), shareReplay(1));
  private Alias = this.Image.pipe(aliasImage(), shareReplay(1));

  // Triggers
  private UpdateFunction = new AsyncSubject<{
    FunctionName: string;
    AliasName: string;
    Code?: UpdateFunctionCodeCommandInput;
    Configuration?: UpdateFunctionConfigurationCommandInput;
    Tags?: TagResourceCommandInput;
  }>();

  // DEVNOTE: Do not use these in the observe() method directly
  // Use the corresponding Observable properties instead
  public readonly State: {
    RoleName?: string;
    RoleArn?: string;
    FunctionName?: string;
    FunctionArn?: string;
    FunctionVersion?: string;
    FunctionQualifier?: string;
    FunctionUrl?: string;
    ImageRef?: string;
    Alias?: string;
  } = {};

  constructor(
    _type: LambdaFunction['type'],
    public readonly imageService: LambdaImageService
  ) {
    this.type = _type;
  }

  get log(): Logger {
    return this.imageService.log;
  }

  withImage(image: string): this {
    this.Image.next({
      requested: image,
      normalized: Transfer.normalizeImage(image),
    });
    return this;
  }

  withMemory(memory: number): this {
    this.MemorySize.next(memory);
    return this;
  }

  withEnvironment(key: string, value: string): this {
    const env = this.Environment.getValue();
    env[key] = value;
    this.Environment.next(env);
    return this;
  }

  withTag(key: string, value: string): this {
    const tags = this.Tags.getValue();
    tags[key] = value;
    this.Tags.next(tags);
    return this;
  }

  withState(key: keyof LambdaFunction['State'], value: string): this {
    this.State[key] = value;
    return this;
  }

  public observe(): Observable<LambdaFunction['State']> {
    return new Observable((subscriber) => {
      const subscriptions = [
        this.create().subscribe(() => subscriber.next(this.State)),
        this.update().subscribe(() => subscriber.next(this.State)),
        this.RoleName.subscribe((v) => this.withState('RoleName', v)),
        this.RoleArn.subscribe((v) => this.withState('RoleArn', v)),
        this.FunctionName.subscribe((v) => this.withState('FunctionName', v)),
        this.FunctionArn.subscribe((v) => this.withState('FunctionArn', v)),
        this.FunctionVersion.subscribe((v) => this.withState('FunctionVersion', v)),
        this.FunctionQualifier.subscribe((v) => this.withState('FunctionQualifier', v)),
        this.FunctionUrl.subscribe((v) => this.withState('FunctionUrl', v).withEnvironment('LAMBDA_URL', v)),
        this.ImageRef.subscribe((v) => this.withState('ImageRef', v)),
        this.Alias.subscribe((v) => this.withState('Alias', v)),
      ];

      // TODO: Figure out a better completion condition
      combineLatest([this.FunctionVersion, this.FunctionUrl]).subscribe(([version, url]) => {
        if (version !== '$LATEST' && url) subscriber.complete();
      });

      return () => {
        subscriptions.forEach((s) => s.unsubscribe());
      };
    });
  }

  private create(): Observable<MetadataBearer> {
    return defer(() =>
      merge(
        // Role
        combineLatest([this.Image.pipe(take(1))]).pipe(
          switchMap(([{ normalized }]) =>
            _create(
              () =>
                this.iam.send(
                  new GetRoleCommand({ RoleName: `${normalized.namespace}+${normalized.name}@${normalized.registry}` })
                ),
              () =>
                this.iam.send(
                  new CreateRoleCommand({
                    RoleName: `${normalized.namespace}+${normalized.name}@${normalized.registry}`,
                    AssumeRolePolicyDocument: this.AssumeRolePolicyDocument,
                  })
                ),
              (role) => {
                this.RoleName.next(role.Role!.RoleName!);
                this.RoleArn.next(role.Role!.Arn!);
                this.FunctionName.next(`${normalized.name}-${role.Role!.RoleId}`);
              }
            )
          )
        ),
        // Function
        combineLatest([this.FunctionName.pipe(take(1)), this.RoleArn.pipe(take(1)), this.ImageRef.pipe(take(1))]).pipe(
          switchMap(([FunctionName, Role, ImageUri]) =>
            _create(
              () => this.lambda.send(new GetFunctionCommand({ FunctionName })),
              () =>
                this.lambda.send(
                  new CreateFunctionCommand({
                    FunctionName,
                    Role,
                    Code: { ImageUri },
                    PackageType: 'Image',
                    // TODO: Support for platform annotation
                    Architectures: ['x86_64'],
                    ImageConfig: { EntryPoint: ['rowdy'] },
                    Timeout: 900,
                    Publish: false,
                  })
                ),
              (fn) => {
                this.FunctionArn.next(fn.Configuration!.FunctionArn!);
                this.FunctionVersion.next(fn.Configuration!.Version!);
              }
            )
          )
        ),
        // Alias
        combineLatest([
          this.FunctionName.pipe(take(1)),
          this.Alias.pipe(take(1)),
          this.FunctionVersion.pipe(take(1)),
        ]).pipe(
          switchMap(([FunctionName, Name, FunctionVersion]) =>
            _create(
              () =>
                this.lambda.send(
                  new GetAliasCommand({
                    FunctionName,
                    Name,
                  })
                ),
              () =>
                this.lambda.send(
                  new CreateAliasCommand({
                    FunctionName,
                    Name,
                    FunctionVersion,
                  })
                ),
              (alias) => {
                this.FunctionQualifier.next(alias.Name!);
              }
            )
          )
        ),
        // Function URL
        combineLatest([this.FunctionName.pipe(take(1)), this.FunctionQualifier.pipe(take(1))]).pipe(
          switchMap(([FunctionName, Qualifier]) =>
            _create(
              () =>
                this.lambda.send(
                  new GetFunctionUrlConfigCommand({
                    FunctionName,
                    Qualifier,
                  })
                ),
              () =>
                this.lambda.send(
                  new CreateFunctionUrlConfigCommand({
                    FunctionName: FunctionName,
                    Qualifier,
                    InvokeMode: 'RESPONSE_STREAM',
                    AuthType: 'NONE',
                    Cors: {
                      AllowCredentials: true,
                      AllowOrigins: ['*'],
                      AllowMethods: ['*'],
                      AllowHeaders: ['*'],
                      ExposeHeaders: ['*'],
                      MaxAge: 3600,
                    },
                  })
                ),
              (url) => this.FunctionUrl.next(url.FunctionUrl!)
            )
          )
        ),
        // Function Policy
        combineLatest([this.FunctionName.pipe(take(1)), this.FunctionQualifier.pipe(take(1))]).pipe(
          switchMap(([FunctionName, Qualifier]) =>
            _create(
              () =>
                this.lambda.send(
                  new GetPolicyCommand({
                    FunctionName,
                    Qualifier,
                  })
                ),
              () =>
                Promise.all([
                  this.lambda.send(
                    new AddPermissionCommand({
                      FunctionName,
                      Qualifier,
                      StatementId: 'FunctionURLAllowPublicAccess',
                      Principal: '*',
                      Action: 'lambda:InvokeFunctionUrl',
                      FunctionUrlAuthType: 'NONE',
                    })
                  ),
                  this.lambda.send(
                    new AddPermissionCommand({
                      FunctionName,
                      Qualifier,
                      StatementId: 'FunctionURLInvokeAllowPublicAccess',
                      Principal: '*',
                      Action: 'lambda:InvokeFunction',
                      InvokedViaFunctionUrl: true,
                    })
                  ),
                ])
            )
          )
        )
      )
    );
  }

  private update(): Observable<MetadataBearer> {
    return defer(() =>
      merge(
        // Role Policy
        combineLatest([this.RoleName]).pipe(
          switchMap(([RoleName]) =>
            this.iam.send(
              new PutRolePolicyCommand({
                RoleName,
                PolicyName: 'default',
                PolicyDocument: this.RolePolicyDocument,
              })
            )
          )
        ),
        // Update Trigger Emission
        combineLatest({
          Alias: this.Alias,
          FunctionArn: this.FunctionArn,
          FunctionName: this.FunctionName,
          FunctionQualifier: this.FunctionQualifier,
          FunctionVersion: this.FunctionVersion.pipe(take(1)),
          ImageRef: this.ImageRef,
          MemorySize: this.MemorySize,
          Tags: this.Tags,
          Environment: this.Environment,
        }).pipe(
          switchMap(
            async ({
              Alias,
              FunctionArn,
              FunctionName,
              FunctionQualifier,
              FunctionVersion,
              ImageRef,
              MemorySize,
              Environment,
              Tags,
            }) => {
              const fn = await this.lambda.send(new GetFunctionCommand({ FunctionName, Qualifier: FunctionQualifier }));
              let { Code: _Code, Configuration: _Configuration } = fn;
              let { Variables: _Environment } = _Configuration?.Environment || {};
              let { Tags: _Tags } = await this.lambda.send(new ListTagsCommand({ Resource: FunctionArn }));
              if (ImageRef === _Code?.ImageUri) {
                // Code unchanged
                _Code = undefined;
              }

              if (
                FunctionVersion !== '$LATEST' &&
                _Configuration?.MemorySize === MemorySize &&
                isSubset(Environment, _Environment || {})
              ) {
                // Configuration unchanged
                _Configuration = undefined;
              }

              if (isSubset(Tags, _Tags || {})) {
                // Tags unchanged
                _Tags = undefined;
              }

              this.UpdateFunction.next({
                FunctionName,
                AliasName: Alias,
                Code: _Code ? { FunctionName, ImageUri: ImageRef } : undefined,
                Configuration: _Configuration
                  ? {
                      ...(_Configuration as UpdateFunctionConfigurationCommandInput),
                      RevisionId: undefined,
                      MemorySize,
                      Environment: { ...Environment, ..._Environment },
                    }
                  : undefined,
                Tags: _Tags ? { Resource: FunctionArn, Tags: { ...Tags, ..._Tags } } : undefined,
              });

              this.UpdateFunction.complete();
              return fn;
            }
          )
        ),
        // Update Function
        combineLatest([this.UpdateFunction]).pipe(
          // TODO: Make this more RxJS-y and less Promise-y
          switchMap(async ([{ FunctionName, AliasName: Name, Code, Configuration, Tags }]) => {
            let requests: MetadataBearer[] = [];

            let RevisionId: string | undefined = undefined;
            let VersionId: string | undefined = undefined;

            if (Tags) {
              // TODO: Iam and ECR tagging
              requests.push(await this.lambda.send(new TagResourceCommand(Tags)));
            }

            const waitForSuccess = async (
              res: GetFunctionConfigurationCommandOutput
            ): Promise<GetFunctionConfigurationCommandOutput> => {
              RevisionId = res.RevisionId;
              VersionId = res.Version;

              if (res.LastUpdateStatus === 'Successful') {
                return res;
              }

              await new Promise((resolve) => setTimeout(resolve, 1000));
              return await this.lambda
                .send(new GetFunctionConfigurationCommand({ FunctionName, Qualifier: res.Version }))
                .then(waitForSuccess);
            };

            if (Code) {
              requests.push(await this.lambda.send(new UpdateFunctionCodeCommand(Code)).then(waitForSuccess));
            }

            if (Configuration) {
              requests.push(
                await this.lambda.send(new UpdateFunctionConfigurationCommand(Configuration)).then(waitForSuccess)
              );
            }

            if (RevisionId) {
              requests.push(
                await this.lambda.send(new PublishVersionCommand({ FunctionName, RevisionId })).then(waitForSuccess)
              );
            }

            if (VersionId) {
              requests.push(
                await this.lambda
                  .send(new UpdateAliasCommand({ FunctionName, Name, FunctionVersion: VersionId }))
                  .then((alias) => {
                    this.FunctionVersion.next(alias.FunctionVersion!);
                    return alias;
                  })
              );
            }

            return requests;
          }),
          concatMap((responses) => responses)
        )
      )
    );
  }

  private async delete(): Promise<this> {
    return this;
  }

  debug = (..._content: unknown[]): void => {};
  info = (...content: unknown[]): void => {
    const obj = Array.isArray(content) && content.length === 1 ? content[0] : content;
    if (typeof obj === 'object') {
      const { clientName, commandName, input, output } = obj as {
        clientName?: string;
        commandName?: string;
        input?: unknown;
        output?: unknown;
      };
      this.log.info(`[${clientName ?? 'UnknownClient'}] [${commandName ?? 'UnknownCommand'}]`, {
        input: JSON.stringify(input),
      });
      this.log.debug(`[${clientName ?? 'UnknownClient'}] [${commandName ?? 'UnknownCommand'}]`, {
        output: JSON.stringify(output),
      });
    }
  };
  warn = (..._content: unknown[]): void => {};
  error = (..._content: unknown[]): void => {};

  repr(): string {
    const parts: string[] = [];
    // if (this.resources.function?.Configuration?.FunctionName) {
    //   parts.push(`name=${this.resources.function.Configuration.FunctionName}`);
    // }
    // if (this.resources.alias?.Name) {
    //   parts.push(`alias=${this.resources.alias.Name}`);
    // }
    // if (this.resources.role?.Role?.RoleName) {
    //   parts.push(`role=${this.resources.role.Role.RoleName}`);
    // }
    // if (this.resources.url?.FunctionUrl) {
    //   parts.push(`url=${this.resources.url.FunctionUrl}`);
    // }
    return `${this.type}(${parts.join(', ')})`;
  }

  private get AssumeRolePolicyDocument(): string {
    const document: PolicyDocument = {
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
    return JSON.stringify(document);
  }

  private get RolePolicyDocument(): string {
    const document: PolicyDocument = {
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
    return JSON.stringify(document);
  }
}
