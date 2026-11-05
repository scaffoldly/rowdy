import type { CommandFinished, RunCommandOptions, RunCommandParams, Sandbox, SandboxLookup, SandboxOptions } from '..';
import { isAxiosError } from 'axios';
import {
  catchError,
  defer,
  from,
  fromEvent,
  ignoreElements,
  iif,
  last,
  lastValueFrom,
  map,
  merge,
  NEVER,
  of,
  race,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import { Environment, Logger, maskUrl } from '../..';
import { deploySources } from '../../api/internal/layers';
import { LambdaImageService } from '../../aws/lambda/image';
import { LambdaFunction } from '../../aws/lambda/index';
import { EXEC_STREAM } from '../../proxy/shell';

// Kubernetes' alphabet for generated names: no vowels, so a name spells no words.
const ALPHANUMS = 'bcdfghjklmnpqrstvwxz2456789';

/** Kubernetes' ComputeHash: FNV-1a 32 over the template, its decimal digits encoded with SafeEncodeString. */
export const computeHash = (template: string): string => {
  const hash = Buffer.from(template).reduce((sum, byte) => Math.imul(sum ^ byte, 16777619) >>> 0, 2166136261);
  return [...String(hash)].map((digit) => ALPHANUMS[digit.charCodeAt(0) % ALPHANUMS.length]).join('');
};

export class SandboxImpl implements Sandbox {
  private environment: Environment;
  private lambda: LambdaFunction;

  private constructor({
    image,
    name,
    timeout,
    memory,
    env,
    logLevel,
    signal,
  }: Required<Omit<SandboxOptions, 'logLevel'>> & Pick<SandboxOptions, 'logLevel'>) {
    // A host's terminal stays quiet unless logLevel, ROWDY_LOG_LEVEL, ROWDY_DEBUG or ROWDY_TRACE says otherwise.
    const log = new Logger('sandbox');
    if (logLevel) {
      log.withLevel(logLevel);
    } else if (!process.env.ROWDY_LOG_LEVEL && log.level === 'info') {
      log.withLevel('warn');
    }
    this.environment = new Environment(log, { signal });

    const lambda = new LambdaFunction(
      'Sandbox',
      new LambdaImageService(this.environment).withLayersFrom(deploySources(undefined))
    )
      .withImage(image)
      .withCommand([])
      .withTimeout(timeout / 1000)
      .withMemory(memory)
      .withName(name);
    this.lambda = Object.entries(env).reduce((fn, [key, value]) => fn.withEnvironment(key, value), lambda);
  }

  static async create(options?: SandboxOptions): Promise<SandboxImpl> {
    const timeout = options?.timeout ?? 15 * 60 * 1000;
    const memory = options?.memory ?? 512;

    // Lambda takes Timeout in whole seconds, 1 to 900, and MemorySize in whole MB, 128 to 10240.
    if (!Number.isInteger(timeout / 1000) || timeout < 1000 || timeout > 900_000) {
      throw new RangeError(`timeout must be whole seconds from 1000 to 900000 ms, got ${timeout}`);
    }
    if (!Number.isInteger(memory) || memory < 128 || memory > 10240) {
      throw new RangeError(`memory must be whole MB from 128 to 10240, got ${memory}`);
    }

    // TODO: bake our own image
    const image = options?.image ?? 'e2bdev/base';

    const env = options?.env ?? {};

    // The same options reuse a function, and different ones share no env or config.
    const suffix = computeHash(JSON.stringify({ image, timeout, memory, env: Object.entries(env).sort() }));

    // TODO: a generated suffix, once a sandbox can be deleted: a new name is a new function and role on every create.
    // Kubernetes' generateName suffix: 5 random characters.
    // const suffix = Array.from({ length: 5 }, () => ALPHANUMS[randomInt(ALPHANUMS.length)]).join('');

    const sandbox = new SandboxImpl({
      image,
      // The suffix keeps a sandbox off a function deployed any other way, whose exec must stay off.
      name: `${options?.name || 'sandbox'}-${suffix}`,
      timeout,
      memory,
      env,
      logLevel: options?.logLevel,
      signal: options?.signal ?? new AbortController().signal,
    });
    const { signal } = sandbox.environment;

    return lastValueFrom(
      race(
        iif(() => signal.aborted, of(signal), fromEvent(signal, 'abort')).pipe(
          switchMap(() => throwError(() => signal.reason))
        ),
        defer(() => sandbox.lambda.observe()).pipe(
          last(),
          map(() => sandbox)
        )
      ).pipe(
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
  }

  static async get(_lookup: SandboxLookup): Promise<Sandbox> {
    throw new Error('not implemented');
  }

  get sandboxId(): string {
    const { FunctionArn } = this.lambda.State;
    if (!FunctionArn) {
      throw new Error('Sandbox has no function');
    }
    return FunctionArn;
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
    const params: RunCommandParams =
      typeof command === 'string' ? { cmd: command, args, signal: options?.signal } : command;
    const { signal } = params;

    return lastValueFrom(
      race(
        signal
          ? iif(() => signal.aborted, of(signal), fromEvent(signal, 'abort')).pipe(
              switchMap(() => throwError(() => signal.reason))
            )
          : NEVER,
        this.lambda
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
      )
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

  // TODO: stop
  // async stop(): Promise<void> {
  //   throw new Error('not implemented');
  // }
}
