import type { Writable } from 'stream';
import type { Exec, ExecFinished } from '../api/types';
import type { Level } from '../log';
import type { MICROVM_MEMORY } from './internal/compute';
import { SandboxImpl } from './internal/sandbox';

interface BaseSandboxOptions {
  /** The container image to run. Defaults to `scaffoldly/sandbox`. */
  image?: string;
  /** The prefix of a generated name, `{name}-{suffix}`. Defaults to `sandbox`. */
  name?: string;
  /** Applies to the whole process. Defaults to ROWDY_LOG_LEVEL, ROWDY_DEBUG or ROWDY_TRACE, then `warn`. */
  logLevel?: Level;
  /** Aborts the sandbox's work in progress, including its creation, and stops it if it can `stop`. */
  signal?: AbortSignal;
}

export interface LambdaSandboxOptions extends BaseSandboxOptions {
  /** Where the sandbox runs. Defaults to `lambda`. */
  compute?: 'lambda';
  /** Milliseconds until the sandbox stops: whole seconds, 1000 to 900000. */
  timeout?: number;
  /** Memory in megabytes: a whole number, 128 to 10240. */
  memory?: number;
  /**
   * Environment variables for every command; a command's own `env` overrides them. `HOME` defaults to `/tmp`, the
   * only writable path, and the `XDG_*` base directories to their usual places under it.
   */
  env?: Record<string, string>;
}

export interface MicrovmSandboxOptions extends BaseSandboxOptions {
  /** Where the sandbox runs. */
  compute: 'microvm';
  /** Milliseconds until the sandbox stops: whole seconds, 1000 to 28800000. */
  timeout?: number;
  /** Baseline memory in megabytes. */
  memory?: (typeof MICROVM_MEMORY)[number];
  /** Environment variables for every command, at most 50; a command's own `env` overrides them. */
  env?: Record<string, string>;
}

export type SandboxOptions = LambdaSandboxOptions | MicrovmSandboxOptions;

export interface SandboxLookup {
  sandboxId: string;
  /** Aborts the sandbox's work in progress, and stops it if it can `stop`. */
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
  /** Kills the command and rejects. On `compute: 'lambda'` only the waiting stops: it runs on until it exits or times out. */
  signal?: AbortSignal;
}

// TODO: detached
// export interface DetachedRunCommandParams extends RunCommandParams {
//   detached: true;
// }

export interface RunCommandOptions {
  /** Kills the command and rejects. On `compute: 'lambda'` only the waiting stops: it runs on until it exits or times out. */
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

export type Command = Omit<Exec, 'frames'>;
export type CommandFinished = Omit<ExecFinished, 'frames'>;

/** A running sandbox. */
export interface Sandbox {
  readonly sandboxId: string;
  /** Resolves when the command exits, whatever its exit code; rejects only if it could not run. */
  runCommand(cmd: string, args?: string[], options?: RunCommandOptions): Promise<CommandFinished>;
  // TODO: detached
  // /** Resolves once the command has started. */
  // runCommand(params: DetachedRunCommandParams): Promise<Command>;
  /**
   * Resolves when the command exits, whatever its exit code; rejects only if it could not run. On a sandbox that can
   * `stop`, Ctrl+C during a command stops it, then exits as usual, so nothing is left running. A second Ctrl+C quits.
   */
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  // TODO: writeFiles
  // writeFiles(files: WriteFile[]): Promise<void>;
  // TODO: readFileToBuffer
  // /** Resolves to null when the file does not exist. */
  // readFileToBuffer(file: ReadFile): Promise<Buffer | null>;
  // TODO: mkDir
  // mkDir(path: string): Promise<void>;
  /**
   * Ends everything running in this sandbox, including a command in progress, and everything a `Sandbox.get` of it
   * started. Safe to call more than once. The next command starts it again. `compute: 'lambda'` rejects for now.
   */
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
