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
import { Transfer } from '../../api/internal/transfer';
import { LambdaImageService } from '../../aws/lambda/image';
import { LambdaFunction } from '../../aws/lambda/index';
import { EXEC_STREAM } from '../../proxy/shell';

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
    const { namespace, name, tags } = Transfer.normalizeImage(image);

    const sandbox = new SandboxImpl({
      image,
      // The prefix keeps a sandbox off a function deployed any other way, whose exec must stay off.
      name: `sandbox-${options?.name || `${namespace}-${name}-${tags[0]}`}`,
      timeout,
      memory,
      env: options?.env ?? {},
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
    throw new Error('not implemented');
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
