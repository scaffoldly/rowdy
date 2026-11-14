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
  SandboxOptions,
  SandboxStatus,
  SandboxSummary,
  Event,
} from '..';
import { isAxiosError } from 'axios';
import { posix } from 'path';
import {
  catchError,
  asapScheduler,
  concat,
  concatWith,
  connectable,
  EMPTY,
  filter,
  finalize,
  defaultIfEmpty,
  defer,
  first,
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
  mergeMap,
  NEVER,
  Observable,
  of,
  race,
  scan,
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
import { humanize } from '../../aws/errors';
import { LambdaCompute } from '../../aws/lambda/compute';
import { MicrovmCompute } from '../../aws/microvm/compute';
import { EXEC_STREAM } from '../../proxy/frames';
import { DEFAULTS, SandboxCompute, SandboxComputeClass, SandboxError } from './compute';
import { SandboxPromiseImpl } from './create';
import { Credentials } from '../../aws/credentials';
import { DeleteRoleCommand, DeleteRolePolicyCommand, IAMClient, paginateListRoles } from '@aws-sdk/client-iam';
import { isNotFound, SANDBOX_ROLE_PATH } from '../../aws/shared';

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
  readonly runtime: NonNullable<SandboxOptions['runtime']>;
  private environment: SandboxEnvironment;
  private compute: SandboxCompute;
  private credential$?: Credentials;

  private constructor({
    runtime,
    logLevel,
    pollInterval,
    credentials,
    signal,
  }: Pick<SandboxOptions, 'runtime' | 'logLevel' | 'pollInterval' | 'credentials' | 'signal'>) {
    // A host's stdout is its own. Its terminal stays quiet unless logLevel, ROWDY_LOG_LEVEL, ROWDY_DEBUG or ROWDY_TRACE
    // says otherwise.
    const log = new Logger('sandbox').withSink('stderr');
    if (logLevel) {
      log.withLevel(logLevel);
    } else if (!process.env.ROWDY_LOG_LEVEL && log.level === 'info') {
      log.withLevel('warn');
    }
    this.credential$ = credentials && new Credentials(credentials);
    this.environment = new SandboxEnvironment(log, { signal, pollInterval, credentials: this.credential$?.provider });

    this.runtime = runtime ?? 'aws.microvm';
    this.compute = new RUNTIMES[this.runtime](this.environment);
  }

  static create(options?: SandboxOptions): SandboxPromiseImpl {
    const runtime = options?.runtime ?? 'aws.microvm';
    const sandbox = new SandboxImpl({
      runtime,
      logLevel: options?.logLevel,
      pollInterval: options?.pollInterval,
      credentials: options?.credentials,
      signal: options?.signal,
    });
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

        const meta = options?.meta ?? {};
        const layersFrom = options?.layersFrom ?? [];

        RUNTIMES[runtime].assert({ timeout, memory, env, meta });

        // The same options reuse a function, and different ones share no env or config. No meta or layers hash as before.
        const suffix = computeHash(
          JSON.stringify({
            runtime,
            image,
            timeout,
            memory,
            env: Object.entries(env).sort(),
            ...(Object.keys(meta).length ? { meta: Object.entries(meta).sort() } : {}),
            ...(layersFrom.length ? { layersFrom } : {}),
          })
        );

        // TODO: a generated suffix, once a sandbox can be deleted: a new name is a new function and role on every create.
        // Kubernetes' generateName suffix: 5 random characters.
        // const suffix = Array.from({ length: 5 }, () => ALPHANUMS[randomInt(ALPHANUMS.length)]).join('');

        const name = `${options?.name || 'sandbox'}-${suffix}`;

        return race(
          iif(() => signal.aborted, of(signal), fromEvent(signal, 'abort')).pipe(
            switchMap(() => throwError(() => signal.reason))
          ),
          defer(() =>
            sandbox.compute.create({ image, name, timeout, memory, env, meta, layersFrom, wait: options?.wait ?? true })
          ).pipe(map(() => sandbox.stoppingOnAbort()))
        );
      }).pipe(
        // Work starts after this returns, so `.events()` on the result sees the first step.
        subscribeOn(asapScheduler),
        // An AxiosError carries its request headers and sockets into a caller's logs.
        catchError((error) =>
          throwError(() =>
            isAxiosError(error)
              ? new Error(
                  // Without a response, what failed is in the message.
                  `${error.config?.method?.toUpperCase()} ${maskUrl(error.config?.url ?? '')}: ${error.response?.status ?? (error.message || error.code)}`
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
      sandbox.events()
    );
  }

  static get({
    sandboxId,
    logLevel,
    pollInterval,
    credentials,
    signal: abort,
    meta,
    runtime: only,
  }: SandboxLookup): SandboxPromiseImpl {
    // An id is the sandbox's name, which doesn't say its runtime, so the sandbox is whichever runtime has it.
    const runtimes = only ? [only] : (Object.keys(RUNTIMES) as (keyof typeof RUNTIMES)[]);
    const sandboxes = runtimes.map(
      (runtime) => new SandboxImpl({ runtime, logLevel, pollInterval, credentials, signal: abort })
    );
    type Tried = { found?: SandboxImpl; error?: unknown };

    const attached = lastValueFrom(
      iif(
        // A name, never an ARN or a path to something else in the account.
        () => !sandboxId || /[:/]/.test(sandboxId),
        throwError(() => new SandboxError(`Not a sandbox: ${sandboxId}`)),
        from(sandboxes).pipe(
          mergeMap((sandbox) => {
            const { signal } = sandbox.environment;
            return race(
              iif(() => signal.aborted, of(signal), fromEvent(signal, 'abort')).pipe(
                switchMap(() => throwError(() => signal.reason))
              ),
              defer(() => sandbox.compute.attach(sandboxId, meta)).pipe(map(() => sandbox))
            ).pipe(
              map((found): Tried => ({ found })),
              catchError((error) => {
                sandbox.environment.log.debug('Sandbox Not Attached', { runtime: sandbox.runtime, sandboxId, error });
                return of<Tried>({ error });
              })
            );
          }),
          scan((tried, each) => [...tried, each], [] as Tried[]),
          first((tried) => tried.some(({ found }) => found) || tried.length === sandboxes.length),
          map((tried) => {
            const found = tried.find(({ found }) => found)?.found;
            if (found) return found.stoppingOnAbort();
            const errors = tried.map(({ error }) => error);
            // Anything but missing is what to say. A runtime the caller may not use denies every id, so another
            // runtime's error says more.
            const refused =
              errors.find(
                (error) =>
                  !isNotFound(error) &&
                  !['AccessDenied', 'AccessDeniedException'].includes(`${(error as { name?: string })?.name}`)
              ) ?? errors.find((error) => !isNotFound(error));
            if (refused) throw refused;
            // AWS's own message names the ARN, and so the account.
            throw Object.assign(new SandboxError(`No sandbox named ${sandboxId}`), {
              name: 'ResourceNotFoundException',
            });
          })
        )
      ).pipe(
        // Work starts after this returns, so `.events()` on the result sees the first step.
        subscribeOn(asapScheduler)
      )
    );

    return new SandboxPromiseImpl(
      attached.catch((error) => {
        throw humanize(error);
      }),
      merge(...sandboxes.map((sandbox) => sandbox.events()))
    );
  }

  static list({ runtime, meta = {}, credentials, signal }: SandboxListOptions = {}): Promise<SandboxSummary[]> {
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
        merge(...runtimes.map((each) => RUNTIMES[each].list(credentials))).pipe(
          // A value that isn't a string, like an undefined one, matches no sandbox.
          filter((found) =>
            Object.entries(meta).every(([key, value]) => typeof value === 'string' && found.meta[key] === value)
          ),
          toArray()
        )
      )
    ).catch((error) => {
      throw humanize(error);
    });
  }

  get sandboxId(): string {
    return this.compute.sandboxId;
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

  async status(): Promise<SandboxStatus> {
    return lastValueFrom(this.compute.status()).catch((error) => {
      throw humanize(error);
    });
  }

  static async delete(lookup: SandboxLookup): Promise<void> {
    const sandbox = await SandboxImpl.get(lookup).catch((error) => {
      // Deleted already, or never made. A sandbox the lookup refuses still rejects.
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (sandbox) return sandbox.delete();

    // A create that failed before its image or function existed leaves its role, which names it at the end.
    const name = lookup.sandboxId;
    const iam = new IAMClient({ credentials: lookup.credentials });
    const gone = (error: unknown): Observable<never> => (isNotFound(error) ? EMPTY : throwError(() => error));
    await lastValueFrom(
      from(paginateListRoles({ client: iam }, { PathPrefix: SANDBOX_ROLE_PATH })).pipe(
        concatMap(({ Roles = [] }) => Roles),
        filter(({ RoleName }) => !!name && !!RoleName?.endsWith(`@${name}.rowdy.run`)),
        concatMap(({ RoleName }) =>
          concat(
            defer(() => iam.send(new DeleteRolePolicyCommand({ RoleName, PolicyName: 'RowdyPolicy' }))).pipe(
              catchError(gone)
            ),
            defer(() => iam.send(new DeleteRoleCommand({ RoleName }))).pipe(catchError(gone))
          )
        ),
        toArray(),
        finalize(() => iam.destroy())
      )
    ).catch((error) => {
      throw humanize(error);
    });
  }

  async delete(): Promise<void> {
    await lastValueFrom(this.compute.delete()).catch((error) => {
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
