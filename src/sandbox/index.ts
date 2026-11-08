import type { Observable } from 'rxjs';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Writable } from 'stream';
import type { Exec, ExecFinished, ExecOutput, ExecOutputOptions } from '../api/types';
import type { Event, EventCallback } from '../events';
import type { Level } from '../log';
import type { Tool } from '../mcp/tool';
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
  /** Receives every event from the start of `create`, for as long as the sandbox is in use. */
  onEvent?: EventCallback | PromiseLike<EventCallback>;
}

export interface LambdaSandboxOptions extends BaseSandboxOptions {
  /** Where the sandbox runs. */
  runtime: 'aws.lambda';
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
  /** Where the sandbox runs. Defaults to `aws.microvm`. */
  runtime?: 'aws.microvm';
  /** Milliseconds until the sandbox stops: whole seconds, 1000 to 28800000. */
  timeout?: number;
  /** Baseline memory in megabytes. */
  memory?: (typeof MICROVM_MEMORY)[number];
  /** Environment variables for every command, at most 50; a command's own `env` overrides them. */
  env?: Record<string, string>;
}

export type SandboxOptions = LambdaSandboxOptions | MicrovmSandboxOptions;

export type { Event, EventCallback } from '../events';

export interface SandboxToolsLimits {
  /** The most memory a sandbox can have, in megabytes. */
  memory?: number;
  /** The longest timeout a sandbox can have, in milliseconds. */
  timeout?: number;
  /** The runtimes a sandbox can use. The first is the default. */
  runtimes?: NonNullable<SandboxOptions['runtime']>[];
}

export interface SandboxToolsOptions extends Pick<SandboxOptions, 'logLevel' | 'signal'> {
  /** Comes first in every sandbox's name, `{name}-{model's name}-{suffix}`: letters, digits, `-` and `_` only. */
  name?: string;
  /** What a model can ask for. */
  limits?: SandboxToolsLimits;
  /**
   * Where each sandbox's own tools are registered once `create_sandbox` makes it, named with its suffix, like
   * `run_command_bcdf245678`. They come off when it's stopped, or the signal aborts.
   */
  server?: Pick<McpServer, 'registerTool'>;
}

export type { Tool };

/** A sandbox as `Sandbox.list` finds it. */
export interface SandboxSummary {
  sandboxId: string;
  name: string;
  runtime: NonNullable<SandboxOptions['runtime']>;
  /** Whether a microVM is up, and billed. Undefined on `aws.lambda`, which is billed only while a command runs. */
  running?: boolean;
  /** When the running microVM started. */
  startedAt?: Date;
  /** When the running microVM's `timeout` ends it. */
  stopsAt?: Date;
}

export interface SandboxListOptions {
  /** Only sandboxes on this runtime. Defaults to every runtime. */
  runtime?: NonNullable<SandboxOptions['runtime']>;
  /** Only sandboxes whose name starts with `{name}-`. */
  name?: string;
  signal?: AbortSignal;
}

export interface SandboxLookup extends Pick<SandboxOptions, 'logLevel'> {
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
  /** Receives the sandbox's events while this command runs. */
  onEvent?: EventCallback | PromiseLike<EventCallback>;
  detached?: false;
  /** Kills the command and rejects. On `runtime: 'aws.lambda'` only the waiting stops: it runs on until it exits or times out. */
  signal?: AbortSignal;
}

export interface DetachedRunCommandParams extends Omit<RunCommandParams, 'detached' | 'signal'> {
  /**
   * Resolves once the command has started instead of when it exits, and the command outlives this process. Output
   * keeps reaching `stdout` and `stderr` until it exits. `runtime: 'aws.microvm'` only.
   */
  detached: true;
  /** Stops following the command, without killing it. */
  signal?: AbortSignal;
}

export interface RunCommandOptions {
  /** Kills the command and rejects. On `runtime: 'aws.lambda'` only the waiting stops: it runs on until it exits or times out. */
  signal?: AbortSignal;
  /** Receives the sandbox's events while this command runs. */
  onEvent?: EventCallback | PromiseLike<EventCallback>;
}

export interface WriteFile {
  /** Relative to where a command starts without a `cwd`, unless absolute. Missing directories are made. */
  path: string;
  /** A string is written as UTF-8. */
  content: string | Uint8Array;
  mode?: number;
}

export interface FileRange {
  /** The byte to start at. Defaults to 0. */
  offset?: number;
  /** The most bytes to read. Defaults to the rest of the file. */
  length?: number;
}

export interface ReadFile extends FileRange {
  /** Relative to `cwd`, or else to where a command starts without one, unless absolute. */
  path: string;
  cwd?: string;
}

export interface FileOptions {
  signal?: AbortSignal;
}

export type Command = Omit<Exec, 'frames'>;
export type CommandFinished = Omit<ExecFinished, 'frames'>;
export type CommandOutput = ExecOutput;
export type CommandOutputOptions = ExecOutputOptions;

/** A running sandbox. */
export interface Sandbox {
  readonly sandboxId: string;
  /** Resolves when the command exits, whatever its exit code; rejects only if it could not run. */
  runCommand(cmd: string, args?: string[], options?: RunCommandOptions): Promise<CommandFinished>;
  /** Resolves once the command has started, with its handle. `runtime: 'aws.lambda'` rejects. */
  runCommand(params: DetachedRunCommandParams): Promise<Command>;
  /**
   * Resolves when the command exits, whatever its exit code; rejects only if it could not run. On a sandbox that can
   * `stop`, Ctrl+C during a command stops it, then exits as usual, so nothing is left running. A second Ctrl+C quits.
   */
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  /**
   * Reads part of a command's output back from its log, by its `cmdId`, any time after it started. A log is behind a
   * running command: about 10 seconds on `runtime: 'aws.microvm'` and 30 on `aws.lambda`.
   */
  output(cmdId: string, options?: CommandOutputOptions): Promise<CommandOutput>;
  /** Writes each file, in order, replacing what was there. `runtime: 'aws.lambda'` rejects for now. */
  writeFiles(files: WriteFile[], options?: FileOptions): Promise<void>;
  /**
   * Resolves to null when the file does not exist, and to no bytes from past its end. `runtime: 'aws.lambda'` rejects
   * for now.
   */
  readFileToBuffer(file: ReadFile, options?: FileOptions): Promise<Buffer | null>;
  /** Makes a directory and its parents, and is fine if it's there. `runtime: 'aws.lambda'` rejects for now. */
  mkDir(path: string, options?: FileOptions): Promise<void>;
  /**
   * Ends everything running in this sandbox, including a command in progress, and everything a `Sandbox.get` of it
   * started. Safe to call more than once. The next command starts it again. `runtime: 'aws.lambda'` rejects for now.
   */
  stop(): Promise<void>;
  /** Each event from now on. */
  events(): Observable<Event>;
  /**
   * The MCP tools for this sandbox alone, with no `sandbox_id` input: `run_command`, `read_output`, and `stop_sandbox`
   * where it can stop.
   */
  tools(): Tool[];
}

/**
 * A sandbox on its way. Await it for the sandbox, and call `events` before that to see what it takes. Its `tools` are
 * ready at once, and a call waits for the sandbox.
 */
export interface SandboxPromise extends Promise<Sandbox>, Pick<Sandbox, 'events' | 'tools'> {}

export interface SandboxFactory {
  /** Starts a new sandbox. */
  create(options?: SandboxOptions): SandboxPromise;
  /** Connects to a sandbox that is already running. */
  get(lookup: SandboxLookup): SandboxPromise;
  /** The sandboxes in this account and region. */
  list(options?: SandboxListOptions): Promise<SandboxSummary[]>;
  /** The MCP tools for sandboxes, for a host to add to its own server. */
  tools(options?: SandboxToolsOptions): Tool[];
}

export const Sandbox: SandboxFactory = {
  create: (options) => SandboxImpl.create(options),
  get: (lookup) => SandboxImpl.get(lookup),
  list: (options) => SandboxImpl.list(options),
  tools: (options) => SandboxImpl.tools(options),
};
