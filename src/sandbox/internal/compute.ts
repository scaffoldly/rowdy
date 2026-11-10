import type { Observable } from 'rxjs';
import type { Exec, ExecOutput, ExecOutputOptions } from '../../api/types';
import type { SandboxEnvironment } from './environment';
import type { Event } from '../../events';
import type { AwsSandboxOptions, FileRange, SandboxSummary } from '..';
import type { ExecSchema } from '../../routes';

/** A sandbox can't do this, and trying again won't change that. */
export class SandboxError extends Error {}

/** What a sandbox has unless its options set it: `timeout` in milliseconds, `memory` in MB. */
export const DEFAULTS = { timeout: 15 * 60 * 1000, memory: 512 };

/** The sizes AWS offers a microVM, in MB. */
export const MICROVM_MEMORY = [512, 1024, 2048, 4096, 8192] as const;

/** What a sandbox is, whatever it runs on. `timeout` is in milliseconds, `memory` in MB. */
export type ComputeSpec = {
  image: string;
  name: string;
  timeout: number;
  memory: number;
  env: Record<string, string>;
  /** Kept with the sandbox, for `list` and `attach` to match. */
  meta: Record<string, string>;
  /** Images whose layer goes into the sandbox's, after rowdy's. */
  layersFrom: string[];
};

/** Where a sandbox runs. */
export interface SandboxCompute {
  /** Set once `create` or `attach` has completed. */
  readonly sandboxId: string;
  /** Whether `stop` works here, so an interrupt can use it. */
  readonly stoppable: boolean;
  /** Emits once, when the sandbox is ready for a command. */
  create(spec: ComputeSpec): Observable<this>;
  /** Emits once, when a sandbox `create` made is connected. Refuses one whose meta doesn't have every entry given. */
  attach(sandboxId: string, meta?: Record<string, string>): Observable<this>;
  /** Emits the command's handle once, and completes with the command. */
  exec(event: ExecSchema): Observable<Exec>;
  /** Emits once, with part of a command's output read back from its log. */
  output(cmdId: string, options?: ExecOutputOptions): Observable<ExecOutput>;
  /** Emits once, when nothing is left running. Safe to call more than once. */
  stop(): Observable<this>;
  /** Emits once, when the file is written. */
  writeFile(path: string, content: Uint8Array, mode: number | undefined, signal: AbortSignal): Observable<void>;
  /** Emits the file's bytes once, or null when it isn't there. */
  readFile(path: string, range: FileRange, signal: AbortSignal): Observable<Buffer | null>;
  /** Emits once, when the directory is there. */
  mkDir(path: string, signal: AbortSignal): Observable<void>;
  /** Each step of what this compute does on its provider, from now on. */
  events(): Observable<Event>;
}

export interface SandboxComputeClass {
  new (environment: SandboxEnvironment): SandboxCompute;
  /** Environment variables a sandbox has unless its options set them. */
  readonly env: Record<string, string>;
  /** Throws for a spec this compute can't run, before anything reaches AWS. */
  assert(spec: Pick<ComputeSpec, 'timeout' | 'memory' | 'env' | 'meta'>): void;
  /** Each sandbox on this compute, once. */
  list(credentials?: AwsSandboxOptions['credentials']): Observable<SandboxSummary>;
}
