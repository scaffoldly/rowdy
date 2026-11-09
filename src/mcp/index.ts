/**
 * rowdy's MCP tools, for a host to serve from its own server, one by one.
 *
 * `tools.factory` go on the server at the start. Each `run` takes the SDK first, then the input, then the call's
 * context with what the host adds: the `server`, so `create_sandbox` and `get_sandbox` can register a sandbox's own
 * tools on it, the host's `signal`, and optionally `meta`, `layersFrom`, `limits`, `logLevel` and `pollInterval`. `meta` goes on every
 * sandbox a call creates, and a call only finds sandboxes with it. `layersFrom` goes into every sandbox a call creates. A host wraps `run` with
 * whatever it does around a call.
 *
 * @example
 * ```ts
 * import { McpServer } from '@modelcontextprotocol/server';
 * import { Sandbox } from '@scaffoldly/rowdy/sandbox';
 * import { tools } from '@scaffoldly/rowdy/mcp';
 *
 * const server = new McpServer({ name: 'my-host', version: '1.0.0' });
 * const { signal } = new AbortController();
 *
 * const { name, run, ...config } = tools.factory.create_sandbox;
 * server.registerTool(name, config, (input, ctx) =>
 *   run(Sandbox, input, { ...ctx, server, signal, meta: { sub: 'github:1' }, limits: { runtimes: ['aws.microvm'] } })
 * );
 * ```
 *
 * A host that builds a server per request also passes `changed`, called whenever a sandbox's tools go on or come off
 * `server`, to tell its clients to list tools again. Its new server starts with none of them, so before each request
 * it puts back the tools of every sandbox with its `meta` with `registerTools`:
 *
 * ```ts
 * await registerTools(Sandbox, { ...ctx, server, signal, meta, changed });
 * ```
 *
 * `tools.lazy` are registered by those tools, on the `server` a call gives. To wrap their `run` too, give a
 * `server` whose `registerTool` wraps the callback it's handed.
 *
 * @module
 */
import { Logger } from '../log';
import { createSandbox } from '../sandbox/internal/mcp/create-sandbox';
import { getSandbox } from '../sandbox/internal/mcp/get-sandbox';
import { listSandboxes } from '../sandbox/internal/mcp/list-sandboxes';
import { makeDirectory } from '../sandbox/internal/mcp/make-directory';
import { readFile } from '../sandbox/internal/mcp/read-file';
import { readOutput } from '../sandbox/internal/mcp/read-output';
import { runCommand } from '../sandbox/internal/mcp/run-command';
import { stopSandbox } from '../sandbox/internal/mcp/stop-sandbox';
import { writeFile } from '../sandbox/internal/mcp/write-file';

export type { ServerContext, Tool } from './internal/types';
export { registerTools } from '../sandbox/internal/mcp/create-sandbox';

// A host's stdout is its own, even for a tool that fails before it reaches a sandbox.
new Logger('sandbox').withSink('stderr');

/** Every tool, unbound, keyed by its name. Each `run` takes the SDK it acts on, first. */
export const tools = {
  /** On the server from the start. */
  factory: {
    create_sandbox: createSandbox,
    get_sandbox: getSandbox,
    list_sandboxes: listSandboxes,
    stop_sandbox: stopSandbox,
  },
  /** Registered later, by the tool that gives what they act on, each run with it. */
  lazy: {
    run_command: runCommand,
    read_output: readOutput,
    read_file: readFile,
    write_file: writeFile,
    make_directory: makeDirectory,
  },
};
