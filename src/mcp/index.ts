import { createSandbox } from '../sandbox/internal/mcp/create-sandbox';
import { getSandbox } from '../sandbox/internal/mcp/get-sandbox';
import { listSandboxes } from '../sandbox/internal/mcp/list-sandboxes';
import { makeDirectory } from '../sandbox/internal/mcp/make-directory';
import { readFile } from '../sandbox/internal/mcp/read-file';
import { readOutput } from '../sandbox/internal/mcp/read-output';
import { runCommand } from '../sandbox/internal/mcp/run-command';
import { stopSandbox } from '../sandbox/internal/mcp/stop-sandbox';
import { writeFile } from '../sandbox/internal/mcp/write-file';

export type { BoundTool, ServerContext, Tool } from './tool';

/** Every tool, unbound: each `run` takes the SDK its group is named for, first. */
export const tools = {
  /** On the server from the start, each run with a `SandboxFactory`. */
  factory: [createSandbox, getSandbox, listSandboxes, stopSandbox],
  /**
   * Registered for each sandbox as `create_sandbox` or `get_sandbox` gives it, each run with its `SandboxPromise`. A
   * sandbox that can stop gets its own `stop_sandbox` too, from `factory`.
   */
  sandbox: [runCommand, readOutput, readFile, writeFile, makeDirectory],
};
