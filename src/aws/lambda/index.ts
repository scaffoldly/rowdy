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
  GetRolePolicyCommand,
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
  UpdateAliasCommand,
  CreateAliasCommand,
  UpdateFunctionUrlConfigCommand,
  CreateFunctionUrlConfigCommand,
  AddPermissionCommand,
  GetPolicyCommand,
  FunctionConfiguration,
  DeleteAliasCommand,
  GetFunctionUrlConfigCommand,
  GetFunctionResponse,
  PublishVersionCommand,
  ListFunctionsCommandInput,
  ListFunctionsCommand,
  ListTagsCommand,
  ListAliasesCommandInput,
  ListAliasesCommand,
} from '@aws-sdk/client-lambda';
import { PolicyDocument, Statement } from 'aws-lambda';
import { LambdaImageService } from './image';
import { Image, Transfer } from '../../api/internal/transfer';
import {
  BehaviorSubject,
  combineLatest,
  concat,
  defer,
  EMPTY,
  expand,
  filter,
  forkJoin,
  from,
  fromEvent,
  map,
  merge,
  mergeMap,
  Observable,
  OperatorFunction,
  ReplaySubject,
  retry,
  switchMap,
  take,
  takeUntil,
  tap,
  toArray,
} from 'rxjs';
import promiseRetry from 'promise-retry';
import { inspect } from 'util';
import { Environment, Routes } from '../..';
import { TPulledImage } from '../../api/types';

const TAG_KEY_REGEX = /^(?!aws:)[A-Za-z0-9 _.:\-=+@]{1,128}$/;
const TAG_VALUE_REGEX = /^[A-Za-z0-9 _.:\-=+@]{0,256}$/;
const ENV_VALUE_REGEX = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]*$/u;

export const tagify = (prefix: string, map?: object) =>
  Object.entries(JSON.parse(JSON.stringify(map || {}))).reduce(
    (annotations, [key, value]) => {
      if (!value) return annotations;
      if (typeof value === 'object') {
        annotations[`${prefix}.${key}`] = JSON.stringify(value);
        return annotations;
      }
      annotations[`${prefix}.${key}`] = String(value);
      return annotations;
    },
    {} as Record<string, string>
  );

const isSubset = (subset: Record<string, string>, superset: Record<string, string>): boolean => {
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
  private Tags = new BehaviorSubject<Record<string, string>>({});
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
  private Configuration = new ReplaySubject<GetFunctionResponse['Configuration'] | undefined>(1);

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

  private _status: GetFunctionResponse = {};
  get Status(): GetFunctionResponse {
    return { ...this._status };
  }

  constructor(
    _type: LambdaFunction['type'],
    public readonly imageService: LambdaImageService
  ) {
    this.type = _type;
    this.withTag('run.rowdy', 'aws');
    this.withTag('run.rowdy.aws', 'lambda');
    this.withTag('run.rowdy.user.agent', this.userAgent);

    forkJoin({
      RoleArn: this.RoleArn,
      RoleId: this.RoleId,
      RoleName: this.RoleName,
      Qualifier: this.Qualifier,
      FunctionArn: this.FunctionArn,
      ImageUri: this.ImageUri,
      FunctionVersion: this.FunctionVersion,
      AliasArn: this.AliasArn,
      FunctionUrl: this.FunctionUrl,
      Configuration: this.Configuration,
      Tags: this.Tags,
    });

    merge(
      this.RoleArn.pipe(map((v) => ['RoleArn', v] as const)),
      this.RoleId.pipe(map((v) => ['RoleId', v] as const)),
      this.RoleName.pipe(map((v) => ['RoleName', v] as const)),
      this.Qualifier.pipe(map((v) => ['Qualifier', v] as const)),
      this.FunctionArn.pipe(map((v) => ['FunctionArn', v] as const)),
      this.ImageUri.pipe(map((v) => ['ImageUri', v] as const)),
      this.FunctionVersion.pipe(map((v) => ['FunctionVersion', v] as const)),
      this.AliasArn.pipe(map((v) => ['AliasArn', v] as const)),
      this.FunctionUrl.pipe(map((v) => ['FunctionUrl', v] as const))
    )
      .pipe(tap(([key, value]) => this.withState(key, value)))
      .pipe(takeUntil(fromEvent(this.signal, 'abort')))
      .subscribe();
  }

  isSandbox(): boolean {
    return this.type === 'Sandbox';
  }

  isDeleting(): boolean {
    return this.deleting;
  }

  get userAgent(): string {
    return this.imageService.userAgent;
  }

  get log(): Logger {
    return this.imageService.log;
  }

  get signal(): AbortSignal {
    return this.imageService.signal;
  }

  static fromTags(
    type: LambdaFunction['type'],
    tags: Record<string, string>,
    imageService: LambdaImageService
  ): Observable<LambdaFunction> {
    // Returns all the lambda functions found that match the given tags in an observable stream
    // TODO: Paginate through all functions, filtering by tags
    const lambda = new LambdaClient({});
    tags['run.rowdy.user.agent'] = imageService.userAgent;

    const functions$ = (input: ListFunctionsCommandInput = {}) =>
      defer(() => lambda.send(new ListFunctionsCommand(input))).pipe(
        expand((page) =>
          page.NextMarker ? from(lambda.send(new ListFunctionsCommand({ ...input, Marker: page.NextMarker }))) : EMPTY
        ),
        mergeMap((page) => page.Functions ?? [], Environment.CONCURRENCY) // emits Role objects individually
      );

    const aliases$ =
      (FunctionName: string) =>
      (input: ListAliasesCommandInput = { FunctionName }) =>
        defer(() => lambda.send(new ListAliasesCommand(input))).pipe(
          expand((page) =>
            page.NextMarker ? from(lambda.send(new ListAliasesCommand({ ...input, Marker: page.NextMarker }))) : EMPTY
          ),
          mergeMap((page) => page.Aliases ?? [], Environment.CONCURRENCY) // emits Alias objects individually
        );

    return functions$().pipe(
      filter((fn) => fn.PackageType === 'Image'),
      mergeMap(
        (Function) =>
          from(lambda.send(new ListTagsCommand({ Resource: Function.FunctionArn }))).pipe(
            map(({ Tags }) => ({ Function, Tags }))
          ),
        Environment.CONCURRENCY
      ),
      filter(({ Tags }) => isSubset(tags, Tags || {})),
      mergeMap(({ Function }) => {
        if (type === 'Sandbox') {
          return new LambdaFunction('Sandbox', imageService).withArn(Function.FunctionArn!);
        }
        return aliases$(Function.FunctionName!)().pipe(
          mergeMap(
            (Alias) => new LambdaFunction('Container', imageService).withArn(Alias.AliasArn!),
            Environment.CONCURRENCY
          )
        );
      }, Environment.CONCURRENCY)
    );
  }

  withArn(arn: string): Observable<this> {
    if (this.isSandbox()) {
      this.Qualifier.next(undefined);
      this.FunctionArn.next(arn);
    } else {
      const parts = arn.split(':');
      this.Qualifier.next(parts.pop());
      this.FunctionArn.next(parts.join(':'));
      this.AliasArn.next(arn);
      // TODO: $LATEST is being emitted incorrectly here
    }

    return combineLatest([this.FunctionArn.pipe(take(1)), this.Qualifier.pipe(take(1))])
      .pipe(takeUntil(fromEvent(this.signal, 'abort')))
      .pipe(
        switchMap(([FunctionArn, Qualifier]) =>
          from(this.lambda.send(new GetFunctionCommand({ FunctionName: FunctionArn! }))).pipe(
            map(({ Tags }) => ({ FunctionArn, Qualifier, Tags }))
          )
        ),
        switchMap(({ FunctionArn, Qualifier, Tags }) =>
          from(this.lambda.send(new GetFunctionCommand({ FunctionName: FunctionArn!, Qualifier }))).pipe(
            map(({ Configuration, Code }) => ({ Configuration, Code, Tags }))
          )
        ),
        switchMap(({ Configuration, Code, Tags }) =>
          from(this.iam.send(new GetRoleCommand({ RoleName: Configuration!.Role!.split('/').pop()! }))).pipe(
            map(({ Role }) => ({ Configuration, Code, Tags, Role }))
          )
        ),
        switchMap(({ Configuration, Code, Tags, Role }) =>
          from(this.iam.send(new GetRolePolicyCommand({ RoleName: Role?.RoleName, PolicyName: 'RowdyPolicy' }))).pipe(
            map((Policy) => ({ Configuration, Code, Tags, Role, Policy }))
          )
        ),
        switchMap(({ Configuration, Code, Tags, Role, Policy }) =>
          from(this.lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: Configuration?.FunctionArn }))).pipe(
            map((FunctionUrl) => ({ Configuration, Code, Tags, Role, Policy, FunctionUrl }))
          )
        ),
        tap(({ Configuration, Code, Tags, Role, Policy, FunctionUrl }) => {
          // Reactive Properties
          if (Configuration?.FunctionName) this.Name.next(Configuration?.FunctionName);
          if (Code?.ImageUri) {
            this.Image.next({
              requested: Code?.ImageUri,
              normalized: Transfer.normalizeImage(Code?.ImageUri || ''),
            });
          }
          if (Configuration?.MemorySize) this.MemorySize.next(Configuration?.MemorySize);
          if (Configuration?.Environment?.Variables) this.Environment.next(Configuration?.Environment?.Variables);
          if (Tags) this.Tags.next(Tags);
          if (Configuration?.ImageConfigResponse?.ImageConfig?.EntryPoint)
            this.EntryPoint.next(Configuration?.ImageConfigResponse?.ImageConfig?.EntryPoint);
          if (Configuration?.ImageConfigResponse?.ImageConfig?.Command)
            this.Command.next(Configuration?.ImageConfigResponse?.ImageConfig?.Command);
          if (Configuration?.ImageConfigResponse?.ImageConfig?.WorkingDirectory)
            this.WorkingDirectory.next(Configuration?.ImageConfigResponse?.ImageConfig?.WorkingDirectory);
          if (Configuration?.Environment?.Variables?.ROWDY_ROUTES)
            this.Routes.next(Routes.fromDataURL(Configuration.Environment.Variables.ROWDY_ROUTES));
          if (Policy?.PolicyDocument) {
            const policy = JSON.parse(decodeURIComponent(Policy.PolicyDocument));
            const statements = policy.Statement as Statement[];
            this.RoleStatements.next(statements);
          }

          // Resource Properties
          if (Role?.RoleName) this.RoleName.next(Role.RoleName);
          if (Role?.Arn) this.RoleArn.next(Role.Arn);
          if (Role?.RoleId) this.RoleId.next(Role.RoleId);
          if (Code?.ImageUri) this.ImageUri.next(Code.ImageUri);
          if (Configuration?.Version !== '$LATEST') this.FunctionVersion.next(Configuration?.Version);
          if (FunctionUrl.FunctionUrl) this.FunctionUrl.next(FunctionUrl.FunctionUrl);

          this._status = {
            Configuration,
            Tags,
          };
        })
      )
      .pipe(map(() => this));
  }

  withName(name: string): this {
    this.Name.next(name);
    return this;
  }

  withImage(image: string): this {
    const normalized = Transfer.normalizeImage(image);
    this.Image.next({
      requested: image,
      normalized: Transfer.normalizeImage(image),
    });
    return Object.entries(
      tagify('run.rowdy.image', {
        name: normalized.name,
        namespace: normalized.namespace,
        registry: normalized.registry,
      })
    ).reduce((fn, [key, value]) => fn.withTag(key, value), this);
  }

  withMemory(memory: number): this {
    if (memory < 128) {
      memory = 128;
    }
    this.MemorySize.next(memory);
    return this;
  }

  withEnvironment(key: string, value: string, overwrite = true): this {
    key = key
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/^([0-9])/, '_$1') // avoid leading digit
      .replace(/_+/g, '_') // collapse runs
      .replace(/^_+|_+$/g, '') // trim underscores
      .toUpperCase();

    const env = this.Environment.getValue();

    if (!ENV_VALUE_REGEX.test(value)) {
      this.Environment.next(env);
      return this;
    }

    if (key && (overwrite || !(key in env))) {
      if (!value) delete env[key];
      if (value) env[key] = value;
    }

    this.Environment.next(env);
    return this;
  }

  withTag(key: string, value?: string): this {
    const tags = this.Tags.getValue();

    if (!value || !TAG_VALUE_REGEX.test(value) || !TAG_KEY_REGEX.test(key)) {
      delete tags[key];
      this.withEnvironment(key, '');
    }

    if (value) {
      tags[key] = value;
      this.withEnvironment(key, value);
    }

    this.Tags.next(tags);
    return this;
  }

  withCommand(command: string[] | string): this {
    if (typeof command === 'string') {
      // TODO: parsing library
      command = command
        .trim()
        .split(' ')
        .filter((s) => s.length);
    }
    if (!command.length) {
      return this;
    }
    this.Command.next(command);
    return this;
  }

  withWorkingDirectory(workingDir: string): this {
    this.WorkingDirectory.next(workingDir);
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

  withSecrets(secrets: unknown): this {
    if (!secrets || typeof secrets !== 'string') {
      this.log.warn('Unknown secrets format, skipping', { type: typeof secrets });
      return this;
    }
    return Object.entries(JSON.parse(secrets))
      .filter(([key]) => key !== 'github_token') // DEVNOTE: Excluding "github_token" added by default in GH Actions
      .reduce((fn, [key, value]) => fn.withEnvironment(key, String(value)), this);
  }

  withCRI(): this {
    return this.withServe().withRoleStatement({
      Effect: 'Allow',
      Resource: '*',
      Action: [
        'ecr:*',
        'lambda:*',
        'iam:CreateRole',
        'iam:DeleteRole',
        'iam:DeleteRolePolicy',
        'iam:GetRole',
        'iam:GetRolePolicy',
        'iam:PassRole',
        'iam:PutRolePolicy',
        'iam:TagRole',
        'iam:UpdateAssumeRolePolicy',
        'iam:UpdateRole',
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

  private withServe(): this {
    const entryPoint = this.EntryPoint.getValue();
    if (!entryPoint.includes('serve')) {
      entryPoint.push('serve');
    }
    this.EntryPoint.next(entryPoint);
    return this.withEnvironment('ROWDY_GRPC_URL', `http://localhost:7939`);
  }

  private withState<K extends keyof LambdaFunction['State']>(key: K, value?: LambdaFunction['State'][K]): this {
    this.log.debug('State Updated', { key, value });
    if (value) {
      this.State[key] = value;
    }
    if (!value) delete this.State[key];
    return this;
  }

  observe(): Observable<this> {
    return new Observable<this>((subscriber) => {
      this.deleting = false;
      const { creates, updates, tags } = this.prepare();
      const subscription = combineLatest(creates)
        .pipe(
          takeUntil(fromEvent(this.signal, 'abort')),
          tap(() => subscriber.next(this)),
          switchMap(() =>
            concat(...updates, ...tags).pipe(
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

  delete(): Observable<this> {
    return new Observable<this>((subscriber) => {
      this.deleting = true;
      const { deletes } = this.prepare();
      const subscription = combineLatest(deletes)
        .pipe(
          takeUntil(fromEvent(this.signal, 'abort')),
          tap(() => subscriber.next(this)),
          toArray()
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
      const _sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
      return _sanitize(name || roleId);
    };

    const _roleName = (image: Image, name?: string) => {
      const _sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '.');
      return name
        ? `${image.namespace}+${image.name}@${_sanitize(name)}.rowdy.run`
        : `${image.namespace}+${image.name}@rowdy.run`;
    };

    const _qualifier = (image: Image) => {
      const _sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
      if (this.isSandbox()) {
        return '$LATEST';
      }
      let qualifier = image.tags[0] || image.digest;
      if (qualifier.startsWith('sha256:')) {
        qualifier = `sha256-${qualifier.split('sha256:')[1]?.substring(0, 12)}`;
      }
      return _sanitize(qualifier);
    };

    const creates: Observable<MetadataBearer>[] = [
      combineLatest([this.Image.pipe(take(1)), this.Name.pipe(take(1))]).pipe(
        tap(([_, Name]) => {
          this.withTag('run.rowdy.name', Name);
        }),
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
        Qualifier: this.Qualifier.pipe(take(1)),
        RoleArn: this.RoleArn.pipe(take(1)),
        RoleId: this.RoleId.pipe(take(1)),
        PulledImage: this.Image.pipe(take(1), pullImage(this)),
        Command: this.Command.pipe(take(1)),
        WorkingDirectory: this.WorkingDirectory.pipe(take(1)),
      }).pipe(
        map(({ Name, Qualifier, RoleArn, RoleId, PulledImage, Command, WorkingDirectory }) => ({
          FunctionName: _functionName(RoleId!, Name),
          Qualifier,
          Description: `A function to run the ${PulledImage.Image} container in AWS Lambda`,
          Role: RoleArn,
          PulledImage,
          Command,
          WorkingDirectory,
        })),
        switchMap(({ FunctionName, Qualifier, Role, PulledImage, Command, WorkingDirectory }) =>
          _create(
            () =>
              this.lambda
                .send(new GetFunctionCommand({ FunctionName, Qualifier }))
                .catch(() => this.lambda.send(new GetFunctionCommand({ FunctionName }))),
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
              this._status.Configuration = fn.Configuration;
              this.FunctionArn.next(fn.Configuration?.FunctionArn?.replace(/(function:[^:]+):.+$/, '$1'));
              this.ImageUri.next(PulledImage.ImageUri);
              this.WorkingDirectory.next(WorkingDirectory || PulledImage.WorkDir);
              this.Command.next(Command || [...(PulledImage.Entrypoint || []), ...(PulledImage.Command || [])]);
              Object.entries(PulledImage.Environment || {}).forEach(
                ([key, value]) => this.withEnvironment(key, value, false) // Don't overwrite existing env vars
              );
            }
          )
        )
      ),
    ];

    const tags = [
      combineLatest([this.RoleName.pipe(take(1)), this.Tags.pipe(take(1))]).pipe(
        switchMap(([RoleName, Tags]) =>
          this.iam.send(
            new TagRoleCommand({ RoleName, Tags: Object.entries(Tags).map(([Key, Value]) => ({ Key, Value })) })
          )
        )
      ),
      combineLatest([this.FunctionArn.pipe(take(1)), this.Tags.pipe(take(1))]).pipe(
        switchMap(([Resource, Tags]) =>
          from(this.lambda.send(new TagResourceCommand({ Resource, Tags }))).pipe(
            switchMap(() => this.lambda.send(new GetFunctionCommand({ FunctionName: Resource })))
          )
        ),
        tap(({ Tags }) => (this._status.Tags = Tags))
      ),
    ];

    const deletes = this.isSandbox()
      ? [
          // Full delete for sandboxes
          this.FunctionArn.pipe(take(1)).pipe(
            switchMap((FunctionName) =>
              this.lambda.send(new GetFunctionConfigurationCommand({ FunctionName })).then((Configuration) => {
                this.RoleName.next(Configuration.Role!.split('/').pop()!);
                return Configuration;
              })
            ),
            switchMap(({ FunctionName }) => this.lambda.send(new DeleteFunctionCommand({ FunctionName }))),
            tap(() => {
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
        ]
      : [
          // Partial delete for containers
          this.AliasArn.pipe(take(1)).pipe(
            map((aliasArn) => {
              const parts = aliasArn?.split(':') || [];
              const alias = parts.pop();
              const functionName = parts.join(':');
              return { FunctionName: functionName, Name: alias! };
            }),
            switchMap(({ FunctionName, Name }) => this.lambda.send(new DeleteAliasCommand({ FunctionName, Name }))),
            tap(() => {
              this.Qualifier.next(undefined);
              this.AliasArn.next(undefined);
              this.FunctionUrl.next(undefined);
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
                .send(new GetFunctionCommand({ FunctionName: FunctionArn, Qualifier: Qualifier }))
                .catch(() => this.lambda.send(new GetFunctionCommand({ FunctionName: FunctionArn })))
            ).pipe(
              map((Function) => ({
                Function,
                MemorySize,
                Environment,
                ImageUri,
                EntryPoint: [...EntryPoint, '--'], // TODO: add the "--" before this
                Command,
                WorkingDirectory,
              }))
            )
        ),
        switchMap(({ Function, MemorySize, Environment, ImageUri, EntryPoint, Command, WorkingDirectory }) => {
          const { Code = {} } = Function;
          let { Configuration = {} } = Function;
          const { FunctionName } = Configuration;
          let { Version } = Configuration;

          const update: { code: boolean; config: boolean } = {
            code: !isEqual(Code?.ImageUri, ImageUri),
            config:
              Version === '$LATEST' ||
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
            );
          }

          if (update.code) {
            deploy = deploy
              .then(() =>
                this.lambda.send(
                  new UpdateFunctionCodeCommand({
                    FunctionName,
                    ImageUri,
                    Publish: false,
                  })
                )
              )
              .then(waitForSuccess(this.lambda));
          }

          if (update.code || update.config) {
            deploy = deploy
              .then(({ RevisionId }) =>
                this.lambda.send(
                  new PublishVersionCommand({
                    FunctionName,
                    RevisionId,
                    CodeSha256: ImageUri?.split('@sha256:').pop(),
                  })
                )
              )
              .then((published) => {
                Version = published.Version;
                return published;
              })
              .then(waitForSuccess(this.lambda));
          }

          return from(deploy).pipe(
            switchMap(() =>
              this.lambda.send(new GetFunctionConfigurationCommand({ FunctionName, Qualifier: Version }))
            ),
            tap((Configuration) => {
              this._status.Configuration = Configuration;
              this.FunctionVersion.next(Configuration.Version);
            })
          );
        })
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
