import { LambdaClient, ListTagsCommand, paginateListFunctions } from '@aws-sdk/client-lambda';
import {
  concatMap,
  defer,
  filter,
  finalize,
  from,
  last,
  map,
  mergeMap,
  Observable,
  shareReplay,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import { ROWDY_LAYERS } from '../../api/internal/layers';
import { Exec, ExecOutput, ExecOutputOptions } from '../../api/types';
import type { Event } from '../../events';
import type { AwsSandboxOptions, SandboxSummary } from '../../sandbox';
import type { ExecSchema } from '../../routes';
import { ComputeSpec, SandboxCompute, SandboxError } from '../../sandbox/internal/compute';
import { META_TAG, TAG_KEY_REGEX, TAG_VALUE_REGEX } from '../tags';
import { concurrency } from '../../concurrency';
import type { SandboxEnvironment } from '../../sandbox/internal/environment';
import { execOutput } from '../exec';
import type { LambdaFunction } from './index';

export class LambdaCompute implements SandboxCompute {
  // Only /tmp is writable on Lambda. The XDG directories are the spec's defaults under that HOME.
  static readonly env = {
    HOME: '/tmp',
    XDG_CACHE_HOME: '/tmp/.cache',
    XDG_CONFIG_HOME: '/tmp/.config',
    XDG_DATA_HOME: '/tmp/.local/share',
    XDG_STATE_HOME: '/tmp/.local/state',
  };

  // Lambda takes Timeout in whole seconds, 1 to 900, and MemorySize in whole MB, 128 to 10240.
  static assert({ timeout, memory, meta }: Pick<ComputeSpec, 'timeout' | 'memory' | 'meta'>): void {
    if (!Number.isInteger(timeout / 1000) || timeout < 1000 || timeout > 900_000) {
      throw new RangeError(`timeout must be whole seconds from 1000 to 900000 ms, got ${timeout}`);
    }
    if (!Number.isInteger(memory) || memory < 128 || memory > 10240) {
      throw new RangeError(`memory must be whole MB from 128 to 10240, got ${memory}`);
    }
    Object.entries(meta).forEach(([key, value]) => {
      if (typeof value !== 'string' || !TAG_KEY_REGEX.test(`${META_TAG}${key}`) || !TAG_VALUE_REGEX.test(value)) {
        throw new RangeError(`meta must be what AWS takes in a tag, got ${key}=${value}`);
      }
    });
  }

  static list(credentials?: AwsSandboxOptions['credentials']): Observable<SandboxSummary> {
    const lambda = new LambdaClient({ credentials });
    return from(paginateListFunctions({ client: lambda }, {})).pipe(
      concatMap(({ Functions = [] }) => Functions),
      // Only a function deployed as a sandbox runs commands.
      filter(({ Environment: env }) => env?.Variables?.ROWDY_SANDBOX === 'true'),
      mergeMap(
        ({ FunctionArn, FunctionName }) =>
          from(lambda.send(new ListTagsCommand({ Resource: FunctionArn }))).pipe(
            map(
              ({ Tags }): SandboxSummary => ({
                sandboxId: FunctionArn!,
                name: FunctionName!,
                runtime: 'aws.lambda',
                meta: Object.fromEntries(
                  Object.entries(Tags ?? {})
                    .filter(([key]) => key.startsWith(META_TAG))
                    .map(([key, value]) => [key.slice(META_TAG.length), value])
                ),
              })
            )
          ),
        concurrency()
      ),
      finalize(() => lambda.destroy())
    );
  }

  readonly stoppable = false;

  // The deployer is most of rowdy, CLI included, so it loads only once a sandbox runs on Lambda.
  private lambda$: Observable<LambdaFunction>;
  private lambda?: LambdaFunction;

  private credentials: AwsSandboxOptions['credentials'];

  constructor(environment: SandboxEnvironment) {
    const { log, signal, name, version, credentials } = environment;
    this.credentials = credentials;
    this.lambda$ = defer(() => Promise.all([import('./index'), import('./image')])).pipe(
      map(
        ([{ LambdaFunction }, { LambdaImageService }]) =>
          new LambdaFunction(
            'Sandbox',
            new LambdaImageService({ log, signal, name, version, credentials, rowdy: environment }).withLayersFrom([
              ROWDY_LAYERS,
            ])
          )
      ),
      tap((lambda) => (this.lambda = lambda)),
      shareReplay(1)
    );
  }

  get sandboxId(): string {
    const FunctionArn = this.lambda?.State.FunctionArn;
    if (!FunctionArn) {
      throw new Error('Sandbox has no function');
    }
    return FunctionArn;
  }

  create({ image, name, timeout, memory, env, meta, layersFrom }: ComputeSpec): Observable<this> {
    return this.lambda$.pipe(
      switchMap((lambda) => {
        lambda.imageService = lambda.imageService.withLayersFrom([ROWDY_LAYERS, ...layersFrom]);
        lambda
          .withImage(image)
          .withCommand([])
          .withTimeout(timeout / 1000)
          .withMemory(memory)
          // The suffix keeps a sandbox off a function deployed any other way, whose exec must stay off.
          .withName(name);
        Object.entries(env).forEach(([key, value]) => lambda.withEnvironment(key, value));
        Object.entries(meta).forEach(([key, value]) => lambda.withTag(`${META_TAG}${key}`, value));
        return defer(() => lambda.observe());
      }),
      last(),
      map(() => this)
    );
  }

  attach(sandboxId: string, meta: Record<string, string> = {}): Observable<this> {
    return this.lambda$.pipe(
      switchMap((lambda) => lambda.withArn(sandboxId)),
      map((lambda) => {
        const { Configuration, Tags } = lambda.Status;
        // A value that isn't a string, like an undefined one, matches no sandbox.
        const matches = Object.entries(meta).every(
          ([key, value]) => typeof value === 'string' && Tags?.[`${META_TAG}${key}`] === value
        );
        // Exec is refused on any other function, so a handle to one could never run a command.
        if (Configuration?.Environment?.Variables?.ROWDY_SANDBOX !== 'true' || !matches) {
          throw new SandboxError(`Not a sandbox: ${sandboxId}`);
        }
        return this;
      })
    );
  }

  exec(event: ExecSchema): Observable<Exec> {
    if (event.spec?.detached) {
      return throwError(() => new SandboxError('detached is not implemented on runtime aws.lambda'));
    }
    return this.lambda$.pipe(switchMap((lambda) => lambda.exec(event)));
  }

  output(cmdId: string, options?: ExecOutputOptions): Observable<ExecOutput> {
    return this.lambda$.pipe(
      switchMap((lambda) => {
        const [, , , region, account] = this.sandboxId.split(':');
        const logGroup = lambda.Status.Configuration?.LoggingConfig?.LogGroup;
        return execOutput(`arn:aws:logs:${region}:${account}:log-group:${logGroup}`, cmdId, options, this.credentials);
      })
    );
  }

  events(): Observable<Event> {
    return this.lambda$.pipe(switchMap((lambda) => lambda.events()));
  }

  stop(): Observable<this> {
    return throwError(() => new SandboxError('stop is not implemented on runtime aws.lambda'));
  }

  writeFile(): Observable<void> {
    return throwError(() => new SandboxError('files are not implemented on runtime aws.lambda'));
  }

  readFile(): Observable<Buffer | null> {
    return throwError(() => new SandboxError('files are not implemented on runtime aws.lambda'));
  }

  mkDir(): Observable<void> {
    return throwError(() => new SandboxError('files are not implemented on runtime aws.lambda'));
  }
}
