import type { Writable } from 'stream';
import type { Level } from '../log';
import { SandboxImpl } from './internal/sandbox';

export interface SandboxOptions {
  /** The container image to run. Defaults to `e2bdev/base`. */
  image?: string;
  /** A name for the sandbox. */
  name?: string;
  /** Milliseconds until the sandbox stops: whole seconds, 1000 to 900000. */
  timeout?: number;
  /** Memory in megabytes: a whole number, 128 to 10240. */
  memory?: number;
  /** Environment variables for every command; a command's own `env` overrides them. */
  env?: Record<string, string>;
  /** Applies to the whole process. Defaults to ROWDY_LOG_LEVEL, ROWDY_DEBUG or ROWDY_TRACE, then `warn`. */
  logLevel?: Level;
  /** Aborts the sandbox's work in progress, including its creation. */
  signal?: AbortSignal;
}

export interface SandboxLookup {
  sandboxId: string;
  signal?: AbortSignal;
}

export interface RunCommandParams {
  /** The binary to run. There is no shell: pipes and redirects need `sh -c`. */
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Receives the command's stdout as it is written. */
  stdout?: Writable;
  /** Receives the command's stderr as it is written. */
  stderr?: Writable;
  // TODO: detached
  // /** Resolves once the command has started instead of when it exits. */
  // detached?: boolean;
  /** Cancels the command. */
  signal?: AbortSignal;
}

// TODO: detached
// export interface DetachedRunCommandParams extends RunCommandParams {
//   detached: true;
// }

export interface RunCommandOptions {
  /** Cancels the command. */
  signal?: AbortSignal;
}

// TODO: writeFiles
// export interface WriteFile {
//   /** Relative to the sandbox's working directory, unless absolute. */
//   path: string;
//   content: Buffer;
//   mode?: number;
// }

// TODO: readFileToBuffer
// export interface ReadFile {
//   /** Relative to the sandbox's working directory, unless absolute. */
//   path: string;
//   signal?: AbortSignal;
// }

/** A command in a sandbox, running or exited. */
export interface Command {
  readonly cmdId: string;
  /** Undefined while the command runs. */
  readonly exitCode: number | undefined;
  /** The stdout written so far, or all of it once the command has exited. */
  stdout(): Promise<string>;
  /** The stderr written so far, or all of it once the command has exited. */
  stderr(): Promise<string>;
  /** Resolves when the command exits, whatever its exit code. */
  wait(): Promise<CommandFinished>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export interface CommandFinished extends Command {
  readonly exitCode: number;
}

/** A running sandbox. */
export interface Sandbox {
  readonly sandboxId: string;
  /** Resolves when the command exits, whatever its exit code; rejects only if it could not run. */
  runCommand(cmd: string, args?: string[], options?: RunCommandOptions): Promise<CommandFinished>;
  // TODO: detached
  // /** Resolves once the command has started. */
  // runCommand(params: DetachedRunCommandParams): Promise<Command>;
  /** Resolves when the command exits, whatever its exit code; rejects only if it could not run. */
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  // TODO: writeFiles
  // writeFiles(files: WriteFile[]): Promise<void>;
  // TODO: readFileToBuffer
  // /** Resolves to null when the file does not exist. */
  // readFileToBuffer(file: ReadFile): Promise<Buffer | null>;
  // TODO: mkDir
  // mkDir(path: string): Promise<void>;
  /** Safe to call more than once. */
  stop(): Promise<void>;
}

export interface SandboxFactory {
  /** Starts a new sandbox. */
  create(options?: SandboxOptions): Promise<Sandbox>;
  /** Connects to a sandbox that is already running. */
  get(lookup: SandboxLookup): Promise<Sandbox>;
}

export const Sandbox: SandboxFactory = {
  create: (options) => SandboxImpl.create(options),
  get: (lookup) => SandboxImpl.get(lookup),
};
