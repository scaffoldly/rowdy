import { LambdaClient, paginateListFunctions } from '@aws-sdk/client-lambda';
import {
  concatMap,
  defer,
  filter,
  finalize,
  from,
  last,
  map,
  Observable,
  shareReplay,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import { ROWDY_LAYERS } from '../../api/internal/layers';
import { Exec, ExecOutput, ExecOutputOptions } from '../../api/types';
import type { Event } from '../../events';
import type { SandboxSummary } from '../../sandbox';
import type { ExecSchema } from '../../routes';
import { ComputeSpec, SandboxCompute, SandboxError } from '../../sandbox/internal/compute';
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
  static assert({ timeout, memory }: Pick<ComputeSpec, 'timeout' | 'memory'>): void {
    if (!Number.isInteger(timeout / 1000) || timeout < 1000 || timeout > 900_000) {
      throw new RangeError(`timeout must be whole seconds from 1000 to 900000 ms, got ${timeout}`);
    }
    if (!Number.isInteger(memory) || memory < 128 || memory > 10240) {
      throw new RangeError(`memory must be whole MB from 128 to 10240, got ${memory}`);
    }
  }

  static list(): Observable<SandboxSummary> {
    const lambda = new LambdaClient({});
    return from(paginateListFunctions({ client: lambda }, {})).pipe(
      concatMap(({ Functions = [] }) => Functions),
      // Only a function deployed as a sandbox runs commands.
      filter(({ Environment: env }) => env?.Variables?.ROWDY_SANDBOX === 'true'),
      map(
        ({ FunctionArn, FunctionName }): SandboxSummary => ({
          sandboxId: FunctionArn!,
          name: FunctionName!,
          runtime: 'aws.lambda',
        })
      ),
      finalize(() => lambda.destroy())
    );
  }

  readonly stoppable = false;

  // The deployer is most of rowdy, CLI included, so it loads only once a sandbox runs on Lambda.
  private lambda$: Observable<LambdaFunction>;
  private lambda?: LambdaFunction;

  constructor(environment: SandboxEnvironment) {
    const { log, signal, name, version } = environment;
    this.lambda$ = defer(() => Promise.all([import('./index'), import('./image')])).pipe(
      map(
        ([{ LambdaFunction }, { LambdaImageService }]) =>
          new LambdaFunction(
            'Sandbox',
            new LambdaImageService({ log, signal, name, version, rowdy: environment }).withLayersFrom([ROWDY_LAYERS])
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

  create({ image, name, timeout, memory, env }: ComputeSpec): Observable<this> {
    return this.lambda$.pipe(
      switchMap((lambda) => {
        lambda
          .withImage(image)
          .withCommand([])
          .withTimeout(timeout / 1000)
          .withMemory(memory)
          // The suffix keeps a sandbox off a function deployed any other way, whose exec must stay off.
          .withName(name);
        Object.entries(env).forEach(([key, value]) => lambda.withEnvironment(key, value));
        return defer(() => lambda.observe());
      }),
      last(),
      map(() => this)
    );
  }

  attach(sandboxId: string): Observable<this> {
    return this.lambda$.pipe(
      switchMap((lambda) => lambda.withArn(sandboxId)),
      map((lambda) => {
        // Exec is refused on any other function, so a handle to one could never run a command.
        if (lambda.Status.Configuration?.Environment?.Variables?.ROWDY_SANDBOX !== 'true') {
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
        return execOutput(`arn:aws:logs:${region}:${account}:log-group:${logGroup}`, cmdId, options);
      })
    );
  }

  events(): Observable<Extract<Event, { source: 'cdk' }>> {
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
