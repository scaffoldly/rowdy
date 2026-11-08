import type {
  Command,
  CommandFinished,
  DetachedRunCommandParams,
  CommandOutput,
  CommandOutputOptions,
  FileOptions,
  ReadFile,
  WriteFile,
  RunCommandOptions,
  RunCommandParams,
  Sandbox,
  SandboxListOptions,
  SandboxLookup,
  SandboxFactory,
  SandboxOptions,
  SandboxPromise,
  SandboxSummary,
  SandboxToolsOptions,
  Tool,
  Event,
} from '..';
import { isAxiosError } from 'axios';
import { posix } from 'path';
import {
  catchError,
  asapScheduler,
  concatWith,
  connectable,
  EMPTY,
  filter,
  finalize,
  defaultIfEmpty,
  defer,
  firstValueFrom,
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
  ReplaySubject,
  switchMap,
  take,
  takeUntil,
  tap,
  throwError,
  toArray,
} from 'rxjs';
import type { Exec, ExecFrame } from '../../api/types';
import { SandboxEnvironment } from './environment';
import { Logger, maskUrl } from '../../log';
import { describeError, humanize } from '../../aws/errors';
import { LambdaCompute } from '../../aws/lambda/compute';
import { MicrovmCompute } from '../../aws/microvm/compute';
import { safeTool, type BoundTool } from '../../mcp/tool';
import { EXEC_STREAM } from '../../proxy/frames';
import { createSandbox } from './mcp/create-sandbox';
import { getSandbox } from './mcp/get-sandbox';
import { runCommand } from './mcp/run-command';
import { listSandboxes } from './mcp/list-sandboxes';
import { makeDirectory } from './mcp/make-directory';
import { readFile } from './mcp/read-file';
import { readOutput } from './mcp/read-output';
import { writeFile } from './mcp/write-file';
import { stopSandbox } from './mcp/stop-sandbox';
import { DEFAULTS, SandboxCompute, SandboxComputeClass, SandboxError } from './compute';
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
  private environment: SandboxEnvironment;
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
    this.environment = new SandboxEnvironment(log, { signal });

    this.compute = new RUNTIMES[runtime ?? 'aws.microvm'](this.environment);
  }

  static create(options?: SandboxOptions): SandboxPromiseImpl {
    const runtime = options?.runtime ?? 'aws.microvm';
    const sandbox = new SandboxImpl({ runtime, logLevel: options?.logLevel, signal: options?.signal });
    const { signal } = sandbox.environment;

    if (options?.onEvent) {
      const onEvent = Promise.resolve(options.onEvent);
      sandbox
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

    // What a person reads says what to do next. Tools tell a model their own way.
    return new SandboxPromiseImpl(
      created.catch((error) => {
        throw humanize(error);
      }),
      sandbox
    );
  }

  static get({ sandboxId, logLevel, signal: abort }: SandboxLookup): SandboxPromiseImpl {
    const runtime = sandboxId.includes(':microvm-image:') ? 'aws.microvm' : 'aws.lambda';
    const sandbox = new SandboxImpl({ runtime, logLevel, signal: abort });
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

    return new SandboxPromiseImpl(
      attached.catch((error) => {
        throw humanize(error);
      }),
      sandbox
    );
  }

  static list({ runtime, name, signal }: SandboxListOptions = {}): Promise<SandboxSummary[]> {
    // A host's stdout is its own.
    new Logger('sandbox').withSink('stderr');
    const runtimes = runtime ? [runtime] : (Object.keys(RUNTIMES) as (keyof typeof RUNTIMES)[]);

    return lastValueFrom(
      race(
        signal
          ? iif(() => signal.aborted, of(signal), fromEvent(signal, 'abort')).pipe(
              switchMap(() => throwError(() => signal.reason))
            )
          : NEVER,
        merge(...runtimes.map((each) => RUNTIMES[each].list())).pipe(
          filter((found) => !name || found.name.startsWith(`${name}-`)),
          toArray()
        )
      )
    ).catch((error) => {
      throw humanize(error);
    });
  }

  static tools(options?: SandboxToolsOptions): BoundTool[] {
    // A host's stdout is its own, even for a tool that fails before it reaches a sandbox.
    new Logger('sandbox').withSink('stderr');
    const { logLevel, name: scope, limits } = options ?? {};
    // The scope goes in every sandbox's name, and a check that can't match would refuse every call.
    if (scope !== undefined && !/^[A-Za-z0-9_-]+$/.test(scope)) {
      throw new RangeError(`name must be letters, digits, '-' or '_', as AWS allows in a name, got ${scope}`);
    }

    // Working in a sandbox is its own tools, registered on the server as it's created.
    const tools: Tool<SandboxFactory>[] = [createSandbox, getSandbox, listSandboxes, stopSandbox];
    return tools.map(({ run, ...tool }): BoundTool => {
      return {
        ...tool,
        run: (input, ctx) => {
          const { signal } = ctx;
          // What a model asks for, held to the host's scope and limits.
          const sandboxes: SandboxFactory = {
            create: (requested) => {
              const runtime = requested?.runtime ?? limits?.runtimes?.[0];
              // An omitted value must not pass a cap below its default.
              const timeout = requested?.timeout ?? (limits?.timeout && Math.min(limits.timeout, DEFAULTS.timeout));
              const memory = requested?.memory ?? (limits?.memory && Math.min(limits.memory, DEFAULTS.memory));

              if (runtime && limits?.runtimes && !limits.runtimes.includes(runtime)) {
                throw new RangeError(`runtime must be one of ${limits.runtimes.join(', ')}, got ${runtime}`);
              }
              if (timeout && limits?.timeout && timeout > limits.timeout) {
                throw new RangeError(`timeout must be at most ${limits.timeout} ms, got ${timeout}`);
              }
              if (memory && limits?.memory && memory > limits.memory) {
                throw new RangeError(`memory must be at most ${limits.memory} MB, got ${memory}`);
              }

              return SandboxImpl.create({
                ...requested,
                runtime,
                timeout,
                memory,
                name: [scope, requested?.name].filter(Boolean).join('-') || undefined,
                logLevel,
                signal,
              } as SandboxOptions);
            },
            get: (lookup) => {
              if (scope && !lookup.sandboxId.split(':').pop()?.startsWith(`${scope}-`)) {
                throw new SandboxError(`Not a sandbox: ${lookup.sandboxId}`);
              }
              return SandboxImpl.get({ ...lookup, logLevel, signal });
            },
            list: async (listOptions) =>
              (await SandboxImpl.list({ ...listOptions, name: scope, signal }))
                // A runtime the host doesn't allow isn't one a model can use.
                .filter((each) => !limits?.runtimes || limits.runtimes.includes(each.runtime)),
            tools: (toolsOptions) => SandboxImpl.tools(toolsOptions),
          };

          return run(sandboxes, input, ctx);
        },
      };
    });
  }

  get sandboxId(): string {
    return this.compute.sandboxId;
  }

  tools(found: SandboxPromiseImpl = new SandboxPromiseImpl(Promise.resolve(this), this)): BoundTool[] {
    // Files are aws.microvm only.
    const microvm = this.compute instanceof MicrovmCompute;
    const tools: Tool<SandboxPromise>[] = [
      runCommand,
      readOutput,
      ...(microvm ? [readFile, writeFile, makeDirectory] : []),
    ];
    // Every lookup is this sandbox, and the sandbox_id is this one's, so a model can't name another.
    const sandboxes: SandboxFactory = {
      create: (options) => SandboxImpl.create(options),
      get: () => found,
      list: (options) => SandboxImpl.list(options),
      tools: (options) => SandboxImpl.tools(options),
    };
    const stops: Tool<SandboxFactory>[] = this.compute.stoppable ? [stopSandbox] : [];

    return [
      ...tools.map(({ run, ...tool }): BoundTool => ({ ...tool, run: (input, ctx) => run(found, input, ctx) })),
      // Waiting for the sandbox_id is the wait for the sandbox, and a failed build is this call's error.
      ...stops.map((tool): BoundTool => {
        const { run } = safeTool(
          {
            ...tool,
            run: async (sdk, input, ctx) => tool.run(sdk, { ...input, sandbox_id: (await found).sandboxId }, ctx),
          } satisfies Tool<SandboxFactory>,
          describeError
        );
        return {
          ...tool,
          inputSchema: tool.inputSchema.omit({ sandbox_id: true }),
          run: (input, ctx) => run(sandboxes, input, ctx),
        };
      }),
    ];
  }

  runCommand(cmd: string, args?: string[], options?: RunCommandOptions): Promise<CommandFinished>;
  runCommand(params: DetachedRunCommandParams): Promise<Command>;
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  async runCommand(
    command: string | RunCommandParams | DetachedRunCommandParams,
    args?: string[],
    options?: RunCommandOptions
  ): Promise<CommandFinished | Command> {
    const params = typeof command === 'string' ? { cmd: command, args, ...options } : command;
    // The sandbox's signal covers its commands too.
    const signal = params.signal ? AbortSignal.any([params.signal, this.environment.signal]) : this.environment.signal;
    const onEvent = params.onEvent && Promise.resolve(params.onEvent);
    const subscription =
      onEvent &&
      this.events()
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

    const exec$ = this.compute.exec({
      apiVersion: 'rowdy.run/v1alpha1',
      kind: 'Exec',
      spec: { cmd: params.cmd, args: params.args, cwd: params.cwd, env: params.env, detached: params.detached },
      status: undefined,
    });
    const written = tap<ExecFrame>(({ stream, payload }) => {
      if (stream === EXEC_STREAM.STDOUT) params.stdout?.write(payload);
      if (stream === EXEC_STREAM.STDERR) params.stderr?.write(payload);
    });
    const aborted$ = iif(() => signal.aborted, of(signal), fromEvent(signal, 'abort')).pipe(
      switchMap(() => throwError(() => signal.reason))
    );

    if (params.detached) {
      // Followed until the command exits or the signal lets go, whoever awaits the handle.
      const following$ = connectable(
        exec$.pipe(
          switchMap((exec) => merge(of(exec), exec.frames.pipe(written, ignoreElements()))),
          takeUntil(fromEvent(signal, 'abort')),
          finalize(() => subscription?.unsubscribe())
        ),
        { connector: () => new ReplaySubject<Exec>(1), resetOnDisconnect: false }
      );
      following$.connect();
      return firstValueFrom(race(aborted$, following$)).catch((error) => {
        throw humanize(error);
      });
    }

    return lastValueFrom(
      race(
        aborted$,
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
        exec$.pipe(switchMap((exec) => merge(exec.frames.pipe(written, ignoreElements()), from(exec.wait()))))
      ).pipe(finalize(() => subscription?.unsubscribe()))
    ).catch((error) => {
      throw humanize(error);
    });
  }

  async writeFiles(files: WriteFile[], options?: FileOptions): Promise<void> {
    const signal = options?.signal
      ? AbortSignal.any([options.signal, this.environment.signal])
      : this.environment.signal;
    // In order, so a file can follow the one it needs.
    await lastValueFrom(
      from(files).pipe(
        concatMap(({ path, content, mode }) =>
          this.compute.writeFile(path, typeof content === 'string' ? Buffer.from(content) : content, mode, signal)
        ),
        defaultIfEmpty(undefined)
      )
    ).catch((error) => {
      throw humanize(error);
    });
  }

  async readFileToBuffer({ path, cwd, offset, length }: ReadFile, options?: FileOptions): Promise<Buffer | null> {
    const signal = options?.signal
      ? AbortSignal.any([options.signal, this.environment.signal])
      : this.environment.signal;
    return lastValueFrom(
      this.compute.readFile(cwd ? posix.resolve(cwd, path) : path, { offset, length }, signal)
    ).catch((error) => {
      throw humanize(error);
    });
  }

  async mkDir(path: string, options?: FileOptions): Promise<void> {
    const signal = options?.signal
      ? AbortSignal.any([options.signal, this.environment.signal])
      : this.environment.signal;
    await lastValueFrom(this.compute.mkDir(path, signal)).catch((error) => {
      throw humanize(error);
    });
  }

  async output(cmdId: string, options?: CommandOutputOptions): Promise<CommandOutput> {
    const signal = options?.signal
      ? AbortSignal.any([options.signal, this.environment.signal])
      : this.environment.signal;
    return lastValueFrom(this.compute.output(cmdId, { ...options, signal })).catch((error) => {
      throw humanize(error);
    });
  }

  async stop(): Promise<void> {
    await lastValueFrom(this.compute.stop()).catch((error) => {
      throw humanize(error);
    });
  }

  events(): Observable<Event> {
    return merge(this.compute.events(), this.environment.event$);
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
