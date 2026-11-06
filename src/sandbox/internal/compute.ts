import type { Observable } from 'rxjs';
import type { Exec } from '../../api/types';
import type { Environment } from '../../environment';
import type { ExecSchema } from '../../routes';

/** The sizes AWS offers a microVM, in MB. */
export const MICROVM_MEMORY = [512, 1024, 2048, 4096, 8192] as const;

/** What a sandbox is, whatever it runs on. `timeout` is in milliseconds, `memory` in MB. */
export type ComputeSpec = {
  image: string;
  name: string;
  timeout: number;
  memory: number;
  env: Record<string, string>;
};

/** Where a sandbox runs. */
export interface SandboxCompute {
  /** Set once `create` or `attach` has completed. */
  readonly sandboxId: string;
  /** Emits once, when the sandbox is ready for a command. */
  create(spec: ComputeSpec): Observable<this>;
  /** Emits once, when a sandbox `create` made is connected. */
  attach(sandboxId: string): Observable<this>;
  /** Emits the command's handle once, and completes with the command. */
  exec(event: ExecSchema): Observable<Exec>;
}

export interface SandboxComputeClass {
  new (environment: Environment): SandboxCompute;
  /** Environment variables a sandbox has unless its options set them. */
  readonly env: Record<string, string>;
  /** Throws for a spec this compute can't run, before anything reaches AWS. */
  assert(spec: Pick<ComputeSpec, 'timeout' | 'memory' | 'env'>): void;
}
