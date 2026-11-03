import type { Writable } from 'stream';

export type SandboxOptions = {
  /** The container image to run. */
  image?: string;
  /** A name for the sandbox. */
  name?: string;
  /** Milliseconds until the sandbox stops. */
  timeout?: number;
  /** Memory in megabytes. */
  memory?: number;
  /** Environment variables for every command; a command's own `env` overrides them. */
  env?: Record<string, string>;
  /** Cancels the creation. */
  signal?: AbortSignal;
};

export type SandboxLookup = {
  sandboxId: string;
  signal?: AbortSignal;
};

export type RunCommandParams = {
  /** The binary to run. There is no shell: pipes and redirects need `sh -c`. */
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Receives the command's stdout as it is written. */
  stdout?: Writable;
  /** Receives the command's stderr as it is written. */
  stderr?: Writable;
  /** Resolves once the command has started instead of when it exits. */
  detached?: boolean;
  /** Cancels the command. */
  signal?: AbortSignal;
};

export type RunCommandOptions = Pick<RunCommandParams, 'signal'>;

export type WriteFile = {
  /** Relative to the sandbox's working directory, unless absolute. */
  path: string;
  content: Buffer;
  mode?: number;
};

export type ReadFile = {
  /** Relative to the sandbox's working directory, unless absolute. */
  path: string;
  signal?: AbortSignal;
};

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

export class Sandbox {
  private constructor() {}

  /** Starts a new sandbox. */
  static async create(_options?: SandboxOptions): Promise<Sandbox> {
    throw new Error('not implemented');
  }

  /** Connects to a sandbox that is already running. */
  static async get(_lookup: SandboxLookup): Promise<Sandbox> {
    throw new Error('not implemented');
  }

  get sandboxId(): string {
    throw new Error('not implemented');
  }

  /** Resolves when the command exits, whatever its exit code; rejects only if it could not run. */
  runCommand(cmd: string, args?: string[], options?: RunCommandOptions): Promise<CommandFinished>;
  runCommand(params: RunCommandParams & { detached: true }): Promise<Command>;
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

  /** Resolves to null when the file does not exist. */
  async readFileToBuffer(_file: ReadFile): Promise<Buffer | null> {
    throw new Error('not implemented');
  }

  async mkDir(_path: string): Promise<void> {
    throw new Error('not implemented');
  }

  /** Adds milliseconds to the sandbox's timeout. */
  async extendTimeout(_duration: number): Promise<void> {
    throw new Error('not implemented');
  }

  /** Safe to call more than once. */
  async stop(): Promise<void> {
    throw new Error('not implemented');
  }
}
