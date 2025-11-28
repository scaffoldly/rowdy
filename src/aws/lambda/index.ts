import { MetadataBearer, Logger } from '@smithy/types';
import {
  CreateRoleCommand,
  GetRoleCommand,
  IAMClient,
  UpdateRoleCommand,
  TagRoleCommand,
  DeleteRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  CreateFunctionCommand,
  LambdaClient,
  GetFunctionCommand,
  TagResourceCommand,
  GetFunctionConfigurationCommand,
  GetFunctionConfigurationCommandOutput,
  DeleteFunctionCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  PublishVersionCommand,
  UpdateAliasCommand,
  CreateAliasCommand,
  UpdateFunctionUrlConfigCommand,
  CreateFunctionUrlConfigCommand,
  AddPermissionCommand,
  GetPolicyCommand,
  FunctionConfiguration,
} from '@aws-sdk/client-lambda';
import { PolicyDocument, Statement } from 'aws-lambda';
import { LambdaImageService } from './image';
import { Image, Transfer } from '../../api/internal/transfer';
import {
  BehaviorSubject,
  combineLatest,
  concat,
  defer,
  from,
  map,
  Observable,
  OperatorFunction,
  ReplaySubject,
  retry,
  switchMap,
  take,
  tap,
  toArray,
} from 'rxjs';
import { TAGS } from './config';
import promiseRetry from 'promise-retry';
import { inspect } from 'util';
import { Routes, Rowdy } from '../..';
import { TPulledImage } from '../../api/types';

export const isSubset = (subset: Record<string, string>, superset: Record<string, string>): boolean => {
  for (const key of Object.keys(subset)) {
    if (superset[key] !== subset[key]) {
      return false;
    }
  }
  return true;
};

const isEqual = <T extends number | string | string[]>(a?: T, b?: T): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && !a.some((v, i) => v !== b[i]) : a === b));

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

const waitForSuccess = (lambda: LambdaClient) => (res: GetFunctionConfigurationCommandOutput) =>
  new Promise<GetFunctionConfigurationCommandOutput>((resolve, reject) => {
    if (res.LastUpdateStatus === 'Successful' && res.State === 'Active') {
      return resolve(res);
    }
    setTimeout(
      () =>
        lambda
          .send(new GetFunctionConfigurationCommand({ FunctionName: res.FunctionName, Qualifier: res.Version }))
          .then(waitForSuccess(lambda))
          .then(resolve)
          .catch(reject),
      1000
    );
  });

const pullImage = (
  lambda: LambdaFunction
): OperatorFunction<{ requested: string; normalized: Image }, TPulledImage> => {
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
      map(({ imageRef }) => lambda.imageService.pulledImage(imageRef)!)
    );
};

export class LambdaFunction implements Logger {
  private iam = new IAMClient({ logger: this });
  private lambda = new LambdaClient({ logger: this });

  private type: 'Sandbox' | 'Container';
  private deleting: boolean = false;

  // Reactive Properties
  private Name: BehaviorSubject<string | undefined> = new BehaviorSubject<string | undefined>(undefined);
  private Image: BehaviorSubject<{ requested: string; normalized: Image }> = new BehaviorSubject({
    requested: 'ghcr.io/scaffoldly/rowdy:beta',
    normalized: Transfer.normalizeImage('ghcr.io/scaffoldly/rowdy:beta'),
  });
  private MemorySize = new BehaviorSubject(128);
  private Environment = new BehaviorSubject<Record<string, string>>({});
  private Tags = new BehaviorSubject<Record<string, string>>(
    Object.entries(TAGS).reduce((acc, [, v]) => ({ ...acc, [v]: '' }), {})
  );
  private EntryPoint = new BehaviorSubject<string[]>(['rowdy']);
  private Command = new BehaviorSubject<string[] | undefined>(undefined);
  private WorkingDirectory = new BehaviorSubject<string | undefined>(undefined);
  private Routes = new BehaviorSubject<Routes>(Routes.empty());
  private RoleStatements = new BehaviorSubject<Statement[]>([]);

  // Resource Properties
  private RoleName = new ReplaySubject<string | undefined>(1);
  private RoleArn = new ReplaySubject<string | undefined>(1);
  private RoleId = new ReplaySubject<string | undefined>(1);
  private Qualifier = new ReplaySubject<string | undefined>(1);
  private FunctionArn = new ReplaySubject<string | undefined>(1);
  private ImageUri = new ReplaySubject<string | undefined>(1);
  private FunctionVersion = new ReplaySubject<string | undefined>(1);
  private AliasArn = new ReplaySubject<string | undefined>(1);
  private FunctionUrl = new ReplaySubject<string | undefined>(1);
  // Status Properties
  private Configuration = new ReplaySubject<FunctionConfiguration | undefined>(1);

  public readonly State: {
    RoleArn?: string;
    RoleId?: string;
    RoleName?: string;
    Qualifier?: string;
    FunctionArn?: string;
    ImageUri?: string;
    FunctionVersion?: string;
    AliasArn?: string;
    FunctionUrl?: string;
  } = {};

  public readonly Status: {
    Configuration?: FunctionConfiguration;
  } = {};

  constructor(
    _type: LambdaFunction['type'],
    public readonly imageService: LambdaImageService
  ) {
    this.type = _type;
    // State:
    this.RoleArn.subscribe((v) => this.withState('RoleArn', v));
    this.RoleId.subscribe((v) => this.withState('RoleId', v));
    this.RoleName.subscribe((v) => this.withState('RoleName', v));
    this.Qualifier.subscribe((v) => this.withState('Qualifier', v));
    this.FunctionArn.subscribe((v) => this.withState('FunctionArn', v));
    this.ImageUri.subscribe((v) => this.withState('ImageUri', v));
    this.FunctionVersion.subscribe((v) => this.withState('FunctionVersion', v));
    this.AliasArn.subscribe((v) => this.withState('AliasArn', v));
    this.FunctionUrl.subscribe((v) => this.withState('FunctionUrl', v));
    // Status:
    this.Configuration.subscribe((v) => this.withStatus('Configuration', v));
  }

  isSandbox(): boolean {
    return this.type === 'Sandbox';
  }

  isDeleting(): boolean {
    return this.deleting;
  }

  get log(): Logger {
    return this.imageService.log;
  }

  withName(name: string): this {
    this.Name.next(name);
    return this;
  }

  withImage(image: string): this {
    this.Image.next({
      requested: image,
      normalized: Transfer.normalizeImage(image),
    });
    return this;
  }

  withMemory(memory: number): this {
    if (memory < 128) {
      memory = 128;
    }
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

  withCommand(command: string[] | string): this {
    if (typeof command === 'string') {
      command = command.split(' ').filter((s) => s.length);
    }
    if (!command.length) {
      return this;
    }
    this.Command.next(command);
    return this;
  }

  withRoute(path: string, target: string): this {
    const routes = this.Routes.getValue();
    routes.withPath(path, target);
    this.Routes.next(routes);
    return this.withEnvironment('ROWDY_ROUTES', routes.intoDataURL());
  }

  withRoutes(routes: Routes): this {
    const existing = this.Routes.getValue();
    existing.merge(routes);
    this.Routes.next(existing);
    return this.withEnvironment('ROWDY_ROUTES', existing.intoDataURL());
  }

  withCRI(): this {
    return this.withKeepAlive()
      .withRoute(Rowdy.PATHS.CRI, Rowdy.TARGETS.CRI)
      .withRoleStatement({
        Effect: 'Allow',
        Resource: '*',
        Action: [
          'ecr:*',
          'lambda:*',
          'iam:CreateRole',
          'iam:GetRole',
          'iam:GetRolePolicy',
          'iam:PassRole',
          'iam:PutRolePolicy',
          'iam:UpdateAssumeRolePolicy',
        ],
        // TODO: Restrict to resources tagged by Rowdy
      });
  }

  private withRoleStatement(statement: Statement): this {
    const statements = this.RoleStatements.getValue();
    statements.push(statement);
    this.RoleStatements.next(statements);
    return this;
  }

  private withKeepAlive(): this {
    const entryPoint = this.EntryPoint.getValue();
    if (!entryPoint.includes('--keep-alive')) {
      entryPoint.push('--keep-alive');
    }
    this.EntryPoint.next(entryPoint);
    return this;
  }

  private withState<K extends keyof LambdaFunction['State']>(key: K, value?: LambdaFunction['State'][K]): this {
    if (value) this.State[key] = value;
    if (!value) delete this.State[key];
    return this;
  }

  private withStatus<K extends keyof LambdaFunction['Status']>(key: K, value?: LambdaFunction['Status'][K]): this {
    if (value) this.Status[key] = value;
    if (!value) delete this.Status[key];
    return this;
  }

  observe(signal?: AbortSignal): Observable<this> {
    return new Observable<this>((subscriber) => {
      this.deleting = false;
      signal?.addEventListener('abort', () => subscriber.error(new Error(`Observation aborted: ${signal.reason}`)));
      const { creates, updates, tags } = this.prepare();
      const subscription = combineLatest(creates)
        .pipe(
          tap(() => subscriber.next(this)),
          switchMap(() =>
            concat(...updates, ...tags).pipe(
              tap(() => subscriber.next(this)),
              toArray()
            )
          )
        )
        .pipe(map(() => this))
        .pipe(tap(() => subscriber.complete()))
        .subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
      };
    });
  }

  delete(): Observable<this> {
    return new Observable<this>((subscriber) => {
      this.deleting = true;
      const { creates, deletes } = this.prepare();
      const subscription = combineLatest(creates)
        .pipe(
          tap(() => subscriber.next(this)),
          switchMap(() =>
            concat(...deletes).pipe(
              tap(() => subscriber.next(this)),
              toArray()
            )
          )
        )
        .pipe(map(() => this))
        .subscribe(subscriber);

      return () => {
        subscription.unsubscribe();
      };
    });
  }

  private prepare(): {
    creates: Observable<MetadataBearer>[];
    updates: Observable<MetadataBearer>[];
    tags: Observable<MetadataBearer>[];
    deletes: Observable<MetadataBearer>[];
  } {
    const _functionName = (roleId: string, name?: string) => {
      const _sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_');
      return _sanitize(name || roleId);
    };

    const _roleName = (image: Image, name?: string) => {
      const _sanitize = (s: string) => s.replace(/[^a-zA-Z0-9.]/g, '.');
      return name
        ? `${image.namespace}+${image.name}@${_sanitize(name)}.rowdy.run`
        : `${image.namespace}+${image.name}@rowdy.run`;
    };

    const _qualifier = (image: Image) => {
      if (this.type === 'Sandbox') {
        return '$LATEST';
      }
      let qualifier = image.tags[0] || image.digest;
      if (qualifier.startsWith('sha256:')) {
        qualifier = `sha256-${qualifier.split('sha256:')[1]?.substring(0, 12)}`;
      }
      return qualifier;
    };

    const creates: Observable<MetadataBearer>[] = [
      combineLatest([this.Image.pipe(take(1)), this.Name.pipe(take(1))]).pipe(
        map(([{ normalized: Image }, Name]) => ({
          RoleName: _roleName(Image, Name),
          Description: `Execution role to run ${Image.namespace}/${Image.name} in AWS Lambda`,
          Qualifier: _qualifier(Image),
        })),
        switchMap(({ RoleName, Description, Qualifier }) =>
          _create(
            () =>
              this.iam
                .send(new UpdateRoleCommand({ RoleName, Description }))
                .then(() =>
                  this.iam.send(
                    new UpdateAssumeRolePolicyCommand({
                      RoleName,
                      PolicyDocument: JSON.stringify(this.AssumeRolePolicyDocument),
                    })
                  )
                )
                .then(() => this.iam.send(new GetRoleCommand({ RoleName }))),
            () =>
              this.iam.send(
                new CreateRoleCommand({
                  RoleName,
                  Description,
                  AssumeRolePolicyDocument: JSON.stringify(this.AssumeRolePolicyDocument),
                })
              ),
            (role) => {
              this.RoleName.next(RoleName);
              this.RoleArn.next(role.Role!.Arn!);
              this.RoleId.next(role.Role!.RoleId!);
              this.Qualifier.next(Qualifier);
            }
          )
        )
      ),
      combineLatest({
        Name: this.Name.pipe(take(1)),
        RoleArn: this.RoleArn.pipe(take(1)),
        RoleId: this.RoleId.pipe(take(1)),
        PulledImage: this.Image.pipe(take(1), pullImage(this)),
        Command: this.Command.pipe(take(1)),
      }).pipe(
        map(({ Name, RoleArn, RoleId, PulledImage, Command }) => ({
          FunctionName: _functionName(RoleId!, Name),
          Description: `A function to run the ${PulledImage.Image} container in AWS Lambda`,
          Role: RoleArn,
          PulledImage,
          Command,
        })),
        switchMap(({ FunctionName, Role, PulledImage, Command }) =>
          _create(
            () => this.lambda.send(new GetFunctionCommand({ FunctionName })),
            () =>
              promiseRetry((retry) =>
                this.lambda
                  .send(
                    new CreateFunctionCommand({
                      FunctionName,
                      Role,
                      Code: { ImageUri: PulledImage.ImageUri },
                      PackageType: 'Image',
                      // TODO: Support for platform annotation
                      Architectures: ['x86_64'],
                      Timeout: 900,
                      Publish: false,
                    })
                  )
                  .then(waitForSuccess(this.lambda))
                  .catch(retry)
              ),
            (fn) => {
              this.Configuration.next(fn.Configuration);
              this.FunctionArn.next(fn.Configuration!.FunctionArn?.replace(`:${fn.Configuration!.Version}`, ''));
              this.ImageUri.next(PulledImage.ImageUri);
              this.WorkingDirectory.next(PulledImage.WorkDir);
              this.Command.next(Command || [...(PulledImage.Entrypoint || []), ...(PulledImage.Command || [])]);
            }
          )
        )
      ),
    ];

    const tags: Observable<MetadataBearer>[] = [
      combineLatest([this.RoleName.pipe(take(1)), this.Tags.pipe(take(1))]).pipe(
        switchMap(([RoleName, Tags]) =>
          this.iam.send(
            new TagRoleCommand({ RoleName, Tags: Object.entries(Tags).map(([Key, Value]) => ({ Key, Value })) })
          )
        )
      ),
      combineLatest([this.FunctionArn.pipe(take(1)), this.Tags.pipe(take(1))]).pipe(
        switchMap(([Resource, Tags]) => this.lambda.send(new TagResourceCommand({ Resource, Tags })))
      ),
    ];

    const deletes = [
      this.FunctionArn.pipe(take(1)).pipe(
        switchMap((FunctionName) => this.lambda.send(new DeleteFunctionCommand({ FunctionName }))),
        tap(() => {
          this.Configuration.next(undefined);
          this.FunctionArn.next(undefined);
          this.ImageUri.next(undefined);
          this.Qualifier.next(undefined);
          this.AliasArn.next(undefined);
          this.FunctionUrl.next(undefined);
          this.FunctionVersion.next(undefined);
        })
      ),
      this.RoleName.pipe(take(1)).pipe(
        switchMap((RoleName) =>
          this.iam
            .send(new DeleteRolePolicyCommand({ RoleName, PolicyName: 'RowdyPolicy' }))
            .catch(() => this.iam.send(new GetRoleCommand({ RoleName })))
        )
      ),
      this.RoleName.pipe(take(1)).pipe(
        switchMap((RoleName) => this.iam.send(new DeleteRoleCommand({ RoleName }))),
        tap(() => {
          this.RoleArn.next(undefined);
          this.RoleId.next(undefined);
          this.RoleName.next(undefined);
        })
      ),
    ];

    if (this.isSandbox() || this.isDeleting()) {
      return { creates, updates: [], tags, deletes };
    }

    const updates: Observable<MetadataBearer>[] = [
      // Role Policy
      combineLatest({
        RoleName: this.RoleName.pipe(take(1)),
        RoleStatements: this.RoleStatements.pipe(take(1)),
      }).pipe(
        map(({ RoleName, RoleStatements }) => {
          const RolePolicyDocument = this.RolePolicyDocument;
          RolePolicyDocument.Statement.push(...RoleStatements);
          return { RoleName, RolePolicyDocument };
        }),
        switchMap(({ RoleName, RolePolicyDocument }) =>
          this.iam.send(
            new PutRolePolicyCommand({
              RoleName,
              PolicyName: 'RowdyPolicy',
              PolicyDocument: JSON.stringify(RolePolicyDocument),
            })
          )
        )
      ),
      // Function Configuration & Code
      combineLatest({
        FunctionArn: this.FunctionArn.pipe(take(1)),
        Qualifier: this.Qualifier.pipe(take(1)),
        MemorySize: this.MemorySize.pipe(take(1)),
        Environment: this.Environment.pipe(take(1)),
        ImageUri: this.ImageUri.pipe(take(1)),
        EntryPoint: this.EntryPoint.pipe(take(1)),
        Command: this.Command.pipe(take(1)),
        WorkingDirectory: this.WorkingDirectory.pipe(take(1)),
      }).pipe(
        switchMap(
          ({ FunctionArn, Qualifier, MemorySize, Environment, ImageUri, EntryPoint, Command, WorkingDirectory }) =>
            from(
              this.lambda
                .send(new GetFunctionCommand({ FunctionName: FunctionArn, Qualifier }))
                .catch(() => this.lambda.send(new GetFunctionCommand({ FunctionName: FunctionArn })))
            ).pipe(
              map((Function) => ({
                Function,
                MemorySize,
                Environment,
                ImageUri,
                Qualifier,
                EntryPoint: [...EntryPoint, '--'],
                Command,
                WorkingDirectory,
              }))
            )
        ),
        switchMap(
          ({ Function, MemorySize, Environment, ImageUri, Qualifier, EntryPoint, Command, WorkingDirectory }) => {
            const { Code = {} } = Function;
            let { Configuration = {} } = Function;
            const { FunctionName } = Configuration;

            if (!FunctionName || !Qualifier) {
              // Maybe just return EMPTY
              throw new Error('FunctionName or Qualifier is undefined');
            }

            const update: { code: boolean; config: boolean } = {
              code: Code?.ImageUri !== ImageUri,
              config:
                !isEqual(Configuration.Version, '$LATEST') || // An Alias was never created for the Qualifier
                !isEqual(Configuration.ImageConfigResponse?.ImageConfig?.EntryPoint, EntryPoint) ||
                !isEqual(Configuration.ImageConfigResponse?.ImageConfig?.Command, Command) ||
                !isEqual(Configuration.ImageConfigResponse?.ImageConfig?.WorkingDirectory, WorkingDirectory) ||
                !isEqual(Configuration.MemorySize, MemorySize) ||
                !isSubset(Environment, Configuration.Environment?.Variables || {}),
            };

            let deploy: Promise<FunctionConfiguration> = Promise.resolve(Configuration);

            if (update.config) {
              delete Configuration.RevisionId;
              Configuration.MemorySize = MemorySize;
              Configuration.Environment = {
                Variables: { ...Configuration.Environment?.Variables, ...Environment },
              };

              deploy = deploy.then(() =>
                this.lambda
                  .send(
                    new UpdateFunctionConfigurationCommand({
                      ...Configuration,
                      FunctionName,
                      ImageConfig: {
                        EntryPoint,
                        Command,
                        WorkingDirectory,
                      },
                      Layers: [],
                    })
                  )
                  .then(waitForSuccess(this.lambda))
                  .then((Configuration) =>
                    update.code
                      ? Promise.resolve(Configuration)
                      : this.lambda.send(
                          new PublishVersionCommand({
                            FunctionName,
                            RevisionId: Configuration.RevisionId,
                          })
                        )
                  )
                  .then(waitForSuccess(this.lambda))
              );
            }

            if (update.code) {
              deploy = deploy
                .then(() =>
                  this.lambda.send(
                    new UpdateFunctionCodeCommand({
                      FunctionName,
                      ImageUri,
                      Publish: true,
                    })
                  )
                )
                .then(waitForSuccess(this.lambda));
            }

            return from(deploy).pipe(
              switchMap(({ FunctionArn }) =>
                this.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: FunctionArn }))
              ),
              tap((Configuration) => {
                this.Configuration.next(Configuration);
                this.FunctionVersion.next(Configuration.Version);
              })
            );
          }
        )
      ),
      // Function Alias
      combineLatest([
        this.FunctionArn.pipe(take(1)),
        this.Qualifier.pipe(take(1)),
        this.FunctionVersion.pipe(take(1)),
      ]).pipe(
        switchMap(([FunctionArn, Qualifier, FunctionVersion]) =>
          this.lambda
            .send(
              new UpdateAliasCommand({
                FunctionName: FunctionArn,
                Name: Qualifier!,
                FunctionVersion: FunctionVersion!,
              })
            )
            .catch(() =>
              this.lambda.send(
                new CreateAliasCommand({
                  FunctionName: FunctionArn,
                  Name: Qualifier!,
                  FunctionVersion: FunctionVersion!,
                })
              )
            )
            .then((alias) => {
              this.AliasArn.next(alias.AliasArn);
              return alias;
            })
        )
      ),
      // Fuction URL
      combineLatest([this.FunctionArn.pipe(take(1)), this.AliasArn.pipe(take(1))]).pipe(
        map(([FunctionArn, AliasArn]) => ({ FunctionArn, Qualifier: AliasArn?.split(':').pop() })),
        switchMap(({ FunctionArn, Qualifier }) =>
          this.lambda
            .send(
              new UpdateFunctionUrlConfigCommand({
                FunctionName: FunctionArn,
                Qualifier,
                AuthType: 'NONE',
                InvokeMode: 'RESPONSE_STREAM',
                Cors: {
                  AllowCredentials: true,
                  AllowHeaders: ['*'],
                  AllowMethods: ['*'],
                  AllowOrigins: ['*'],
                  ExposeHeaders: ['*'],
                  MaxAge: 3600,
                },
              })
            )
            .catch(() =>
              this.lambda.send(
                new CreateFunctionUrlConfigCommand({
                  FunctionName: FunctionArn,
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
              )
            )
            .then((url) => {
              this.FunctionUrl.next(url.FunctionUrl);
              return url;
            })
        )
      ),
      // Function URL Permissions
      combineLatest([this.AliasArn.pipe(take(1))]).pipe(
        switchMap(([AliasArn]) =>
          from(this.lambda.send(new GetPolicyCommand({ FunctionName: AliasArn })).catch(() => ({ Policy: '{}' })))
            .pipe(map(({ Policy = '{}' }) => JSON.parse(Policy) as PolicyDocument))
            .pipe(
              switchMap((policy) => {
                const operations: Observable<MetadataBearer>[] = [];
                if (!policy.Statement?.find((s) => s.Sid === 'FunctionURLAllowPublicAccess')) {
                  operations.push(
                    from(
                      this.lambda.send(
                        new AddPermissionCommand({
                          FunctionName: AliasArn,
                          Action: 'lambda:InvokeFunctionUrl',
                          Principal: '*',
                          StatementId: 'FunctionURLAllowPublicAccess',
                          FunctionUrlAuthType: 'NONE',
                        })
                      )
                    )
                  );
                }
                if (!policy.Statement?.find((s) => s.Sid === 'FunctionURLInvokeAllowPublicAccess')) {
                  operations.push(
                    from(
                      this.lambda.send(
                        new AddPermissionCommand({
                          FunctionName: AliasArn,
                          Action: 'lambda:InvokeFunction',
                          Principal: '*',
                          StatementId: 'FunctionURLInvokeAllowPublicAccess',
                          InvokedViaFunctionUrl: true,
                        })
                      )
                    )
                  );
                }

                if (!operations.length) {
                  return this.lambda.send(new GetPolicyCommand({ FunctionName: AliasArn }));
                }
                return concat(...operations);
              })
            )
        )
      ),
    ];

    return { creates, updates, tags, deletes };
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
      this.log.debug(`[${clientName ?? 'UnknownClient'}] [${commandName ?? 'UnknownCommand'}]`, {
        input: JSON.stringify(input),
        output: JSON.stringify(output),
      });
    }
  };
  warn = (..._content: unknown[]): void => {};
  error = (..._content: unknown[]): void => {
    const obj = Array.isArray(_content) && _content.length === 1 ? _content[0] : _content;
    if (typeof obj === 'object') {
      const { clientName, commandName, input, error } = obj as {
        clientName?: string;
        commandName?: string;
        input?: unknown;
        error?: unknown;
      };
      this.log.debug(`[${clientName ?? 'UnknownClient'}] [${commandName ?? 'UnknownCommand'}]`, {
        input: JSON.stringify(input),
        error: inspect(error),
      });
      return;
    }
  };

  private get AssumeRolePolicyDocument(): PolicyDocument {
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
    return document;
  }

  private get RolePolicyDocument(): PolicyDocument {
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
    return document;
  }
}
