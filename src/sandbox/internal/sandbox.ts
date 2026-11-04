import type {
  Command,
  CommandFinished,
  DetachedRunCommandParams,
  ReadFile,
  RunCommandOptions,
  RunCommandParams,
  Sandbox,
  SandboxLookup,
  SandboxOptions,
  WriteFile,
} from '..';
import { defer, fromEvent, iif, last, lastValueFrom, map, of, race, switchMap, tap, throwError } from 'rxjs';
import { Environment, Logger } from '../..';
import { deploySources } from '../../api/internal/layers';
import { LambdaImageService } from '../../aws/lambda/image';
import { LambdaFunction } from '../../aws/lambda/index';

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
  }: Required<Omit<SandboxOptions, 'name' | 'logLevel'>> & Pick<SandboxOptions, 'name' | 'logLevel'>) {
    // A host's terminal stays quiet unless logLevel, ROWDY_LOG_LEVEL, ROWDY_DEBUG or ROWDY_TRACE says otherwise.
    const log = new Logger('sandbox');
    if (logLevel) {
      log.withLevel(logLevel);
    } else if (!process.env.ROWDY_LOG_LEVEL && log.level === 'info') {
      log.withLevel('warn');
    }
    this.environment = new Environment(log, { signal });

    let lambda = new LambdaFunction(
      'Container',
      new LambdaImageService(this.environment).withLayersFrom(deploySources(undefined))
    )
      .withImage(image)
      .withTimeout(timeout / 1000)
      .withMemory(memory);
    if (name) {
      lambda = lambda.withName(name);
    }
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

    const sandbox = new SandboxImpl({
      // TODO: bake our own image
      image: options?.image ?? 'e2bdev/base',
      name: options?.name,
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
  runCommand(params: DetachedRunCommandParams): Promise<Command>;
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  async runCommand(
    _command: string | RunCommandParams,
    _args?: string[],
    _options?: RunCommandOptions
  ): Promise<Command> {
    throw new Error('not implemented');
  }

  async writeFiles(_files: WriteFile[]): Promise<void> {
    throw new Error('not implemented');
  }

  async readFileToBuffer(_file: ReadFile): Promise<Buffer | null> {
    throw new Error('not implemented');
  }

  async mkDir(_path: string): Promise<void> {
    throw new Error('not implemented');
  }

  async stop(): Promise<void> {
    throw new Error('not implemented');
  }
}
