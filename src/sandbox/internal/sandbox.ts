import type {
  CommandFinished,
  RunCommandOptions,
  RunCommandParams,
  Sandbox,
  SandboxLookup,
  SandboxOptions,
  SandboxToolsOptions,
  Tool,
  Event,
} from '..';
import { isAxiosError } from 'axios';
import {
  catchError,
  asapScheduler,
  concatWith,
  EMPTY,
  finalize,
  defer,
  from,
  subscribeOn,
  fromEvent,
  ignoreElements,
  iif,
  lastValueFrom,
  map,
  concatMap,
  merge,
  NEVER,
  Observable,
  of,
  race,
  switchMap,
  take,
  tap,
  throwError,
} from 'rxjs';
import { Environment, Logger, maskUrl } from '../..';
import { LambdaCompute } from '../../aws/lambda/compute';
import { MicrovmCompute } from '../../aws/microvm/compute';
import { EXEC_STREAM } from '../../proxy/shell';
import { createSandbox } from '../mcp/create-sandbox';
import { DEFAULTS, SandboxCompute, SandboxComputeClass } from './compute';
import { SandboxPromiseImpl } from './create';

// Kubernetes' alphabet for generated names: no vowels, so a name spells no words.
const ALPHANUMS = 'bcdfghjklmnpqrstvwxz2456789';

/** Kubernetes' ComputeHash: FNV-1a 32 over the template, its decimal digits encoded with SafeEncodeString. */
export const computeHash = (template: string): string => {
  const hash = Buffer.from(template).reduce((sum, byte) => Math.imul(sum ^ byte, 16777619) >>> 0, 2166136261);
  return [...String(hash)].map((digit) => ALPHANUMS[digit.charCodeAt(0) % ALPHANUMS.length]).join('');
};

const RUNTIMES: Record<NonNullable<SandboxOptions['runtime']>, SandboxComputeClass> = {
  'aws.lambda': LambdaCompute,
  'aws.microvm': MicrovmCompute,
};

export class SandboxImpl implements Sandbox {
  private environment: Environment;
  private compute: SandboxCompute;

  private constructor({ runtime, logLevel, signal }: Pick<SandboxOptions, 'runtime' | 'logLevel' | 'signal'>) {
    // A host's stdout is its own. Its terminal stays quiet unless logLevel, ROWDY_LOG_LEVEL, ROWDY_DEBUG or ROWDY_TRACE
    // says otherwise.
    const log = new Logger('sandbox').withSink('stderr');
    if (logLevel) {
      log.withLevel(logLevel);
    } else if (!process.env.ROWDY_LOG_LEVEL && log.level === 'info') {
      log.withLevel('warn');
    }
    this.environment = new Environment(log, { signal });

    this.compute = new RUNTIMES[runtime ?? 'aws.lambda'](this.environment);
  }

  static create(options?: SandboxOptions): SandboxPromiseImpl {
    const runtime = options?.runtime ?? 'aws.lambda';
    const sandbox = new SandboxImpl({ runtime, logLevel: options?.logLevel, signal: options?.signal });
    const { signal } = sandbox.environment;

    if (options?.onEvent) {
      const onEvent = Promise.resolve(options.onEvent);
      sandbox.compute
        .events()
        .pipe(
          // One at a time, so a slow callback still sees them in order.
          concatMap((event) =>
            from(onEvent.then((callback) => callback(event))).pipe(
              catchError((error) => {
                sandbox.environment.log.warn('Event Callback Failed', { error });
                return EMPTY;
              })
            )
          )
        )
        .subscribe();
    }

    const created = lastValueFrom(
      defer(() => {
        const image = options?.image ?? 'scaffoldly/sandbox';
        const timeout = options?.timeout ?? DEFAULTS.timeout;
        const memory = options?.memory ?? DEFAULTS.memory;
        const env = { ...RUNTIMES[runtime].env, ...options?.env };

        RUNTIMES[runtime].assert({ timeout, memory, env });

        // The same options reuse a function, and different ones share no env or config.
        const suffix = computeHash(
          JSON.stringify({ runtime, image, timeout, memory, env: Object.entries(env).sort() })
        );

        // TODO: a generated suffix, once a sandbox can be deleted: a new name is a new function and role on every create.
        // Kubernetes' generateName suffix: 5 random characters.
        // const suffix = Array.from({ length: 5 }, () => ALPHANUMS[randomInt(ALPHANUMS.length)]).join('');

        const name = `${options?.name || 'sandbox'}-${suffix}`;

        return race(
          iif(() => signal.aborted, of(signal), fromEvent(signal, 'abort')).pipe(
            switchMap(() => throwError(() => signal.reason))
          ),
          defer(() => sandbox.compute.create({ image, name, timeout, memory, env })).pipe(
            map(() => sandbox.stoppingOnAbort())
          )
        );
      }).pipe(
        // Work starts after this returns, so `.events()` on the result sees the first step.
        subscribeOn(asapScheduler),
        // An AxiosError carries its request headers and sockets into a caller's logs.
        catchError((error) =>
          throwError(() =>
            isAxiosError(error)
              ? new Error(
                  `${error.config?.method?.toUpperCase()} ${maskUrl(error.config?.url ?? '')}: ${error.response?.status ?? error.code}`
                )
              : error
          )
        ),
        // A failed step leaves the others in flight until the environment aborts.
        tap({ error: (error) => sandbox.environment.abort.abort(error) })
      )
    );

    return new SandboxPromiseImpl(created, sandbox);
  }

  static get({ sandboxId, signal: abort }: SandboxLookup): SandboxPromiseImpl {
    const runtime = sandboxId.includes(':microvm-image:') ? 'aws.microvm' : 'aws.lambda';
    const sandbox = new SandboxImpl({ runtime, signal: abort });
    const { signal } = sandbox.environment;

    const attached = lastValueFrom(
      race(
        iif(() => signal.aborted, of(signal), fromEvent(signal, 'abort')).pipe(
          switchMap(() => throwError(() => signal.reason))
        ),
        defer(() => sandbox.compute.attach(sandboxId)).pipe(map(() => sandbox.stoppingOnAbort()))
      ).pipe(
        // Work starts after this returns, so `.events()` on the result sees the first step.
        subscribeOn(asapScheduler)
      )
    );

    return new SandboxPromiseImpl(attached, sandbox);
  }

  static tools(options?: SandboxToolsOptions): Tool[] {
    return [createSandbox(SandboxImpl, options)];
  }

  get sandboxId(): string {
    return this.compute.sandboxId;
  }

  runCommand(cmd: string, args?: string[], options?: RunCommandOptions): Promise<CommandFinished>;
  // TODO: detached
  // runCommand(params: DetachedRunCommandParams): Promise<Command>;
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  async runCommand(
    command: string | RunCommandParams,
    args?: string[],
    options?: RunCommandOptions
  ): Promise<CommandFinished> {
    const params: RunCommandParams = typeof command === 'string' ? { cmd: command, args, ...options } : command;
    // The sandbox's signal covers its commands too.
    const signal = params.signal ? AbortSignal.any([params.signal, this.environment.signal]) : this.environment.signal;
    const onEvent = params.onEvent && Promise.resolve(params.onEvent);
    const subscription =
      onEvent &&
      this.compute
        .events()
        .pipe(
          // One at a time, so a slow callback still sees them in order.
          concatMap((event) =>
            from(onEvent.then((callback) => callback(event))).pipe(
              catchError((error) => {
                this.environment.log.warn('Event Callback Failed', { error });
                return EMPTY;
              })
            )
          )
        )
        .subscribe();

    return lastValueFrom(
      race(
        iif(() => signal.aborted, of(signal), fromEvent(signal, 'abort')).pipe(
          switchMap(() => throwError(() => signal.reason))
        ),
        // Only while a command runs, and only where it can stop: a listener cancels Node's default exit. It's gone
        // after the first, so a second Ctrl+C force-quits.
        this.compute.stoppable
          ? fromEvent(process, 'SIGINT').pipe(
              take(1),
              tap(() => this.interrupted()),
              ignoreElements(),
              // Completing would end the race: the command's own rejection is what the caller gets.
              concatWith(NEVER)
            )
          : NEVER,
        this.compute
          .exec({
            apiVersion: 'rowdy.run/v1alpha1',
            kind: 'Exec',
            spec: { cmd: params.cmd, args: params.args, cwd: params.cwd, env: params.env },
            status: undefined,
          })
          .pipe(
            switchMap((exec) =>
              merge(
                exec.frames.pipe(
                  tap(({ stream, payload }) => {
                    if (stream === EXEC_STREAM.STDOUT) params.stdout?.write(payload);
                    if (stream === EXEC_STREAM.STDERR) params.stderr?.write(payload);
                  }),
                  ignoreElements()
                ),
                from(exec.wait())
              )
            )
          )
      ).pipe(finalize(() => subscription?.unsubscribe()))
    );
  }

  // TODO: writeFiles
  // async writeFiles(_files: WriteFile[]): Promise<void> {
  //   throw new Error('not implemented');
  // }

  // TODO: readFileToBuffer
  // async readFileToBuffer(_file: ReadFile): Promise<Buffer | null> {
  //   throw new Error('not implemented');
  // }

  // TODO: mkDir
  // async mkDir(_path: string): Promise<void> {
  //   throw new Error('not implemented');
  // }

  async stop(): Promise<void> {
    await lastValueFrom(this.compute.stop());
  }

  events(): Observable<Event> {
    return this.compute.events();
  }

  // Only once there's a sandbox: an abort before that has nothing to stop.
  private stoppingOnAbort(): this {
    if (this.compute.stoppable) {
      this.environment.signal.addEventListener(
        'abort',
        () => void this.stop().catch((error) => this.environment.log.warn('Sandbox Stop Failed', { error })),
        { once: true }
      );
    }
    return this;
  }

  // Ctrl+C would otherwise end this process and leave the VM running, and billing, until its timeout.
  private interrupted(): void {
    this.stop()
      .catch((error) => this.environment.log.warn('Sandbox Stop Failed', { error }))
      .finally(() => {
        // A host with its own handler decides how it exits.
        if (!process.listenerCount('SIGINT')) {
          process.kill(process.pid, 'SIGINT');
        }
      });
  }
}
