import {
  EMPTY,
  catchError,
  concatMap,
  from,
  ignoreElements,
  iif,
  interval,
  lastValueFrom,
  map,
  merge,
  takeUntil,
} from 'rxjs';
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/server';
import type { Sandbox, SandboxFactory, SandboxOptions } from '../..';
import { DEFAULTS } from '../compute';
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult } from '../../../mcp/internal/tool';
import type { ServerContext, Tool } from '../../../mcp/internal/types';

/** Each sandbox's own tools on each server, so a repeated create doesn't register them twice. */
export const REGISTERED = new WeakMap<Pick<McpServer, 'registerTool'>, Map<string, RegisteredTool[]>>();

/**
 * Registers a sandbox's own tools, named with its suffix, on the context's server, once per server. Answers with their
 * names there, or none without a server. A sandbox that isn't ready yet is fine: each call waits for it.
 */
export const registerSandbox = (
  sandbox: Pick<Sandbox, 'tools'>,
  sandboxId: string,
  { server, signal, meta, limits, logLevel, changed }: ServerContext
): string[] => {
  if (!server) return [];
  // Named with the sandbox's suffix, so two sandboxes' tools don't clash.
  const suffix = sandboxId.split('-').pop();
  const tools = sandbox.tools();
  const names = tools.map(({ name }) => `${name}_${suffix}`);
  const onServer = REGISTERED.get(server) ?? new Map<string, RegisteredTool[]>();
  REGISTERED.set(server, onServer);
  if (onServer.has(sandboxId)) return names;

  const sandboxTools = tools.map(({ name, run, ...config }) =>
    server.registerTool(`${name}_${suffix}`, config, (args, extra) =>
      run(args, { ...extra, server, signal, meta, limits, logLevel, changed })
    )
  );
  onServer.set(sandboxId, sandboxTools);
  changed?.();
  // They come off when the call's signal aborts, unless a stop took them off first. That isn't announced: a host
  // that builds a server per request aborts it with the request, and the server goes with it.
  signal?.addEventListener(
    'abort',
    () => {
      if (onServer.get(sandboxId) !== sandboxTools) return;
      sandboxTools.forEach((tool) => tool.remove());
      onServer.delete(sandboxId);
    },
    { once: true }
  );
  return names;
};

/**
 * Registers the own tools of every sandbox with the context's `meta`, on its runtimes, on the context's server. Answers
 * with their names there, or none without a server. A host that builds a server per request calls it for each.
 */
export const registerTools = async (
  factory: Pick<SandboxFactory, 'list' | 'get'>,
  ctx: ServerContext
): Promise<string[]> => {
  const { server, meta, limits, logLevel, signal } = ctx;
  if (!server) return [];
  const sandboxes = (await factory.list({ meta, signal }))
    // A runtime the host doesn't allow isn't one a model can use.
    .filter((sandbox) => !limits?.runtimes || limits.runtimes.includes(sandbox.runtime));
  return sandboxes.flatMap(({ sandboxId }) =>
    registerSandbox(factory.get({ sandboxId, meta, logLevel, signal }), sandboxId, ctx)
  );
};

/** What a sandbox comes with, for the tools that register its own. */
export const OWN_TOOLS =
  'It gets tools of its own, named with the end of its sandbox_id, like run_command_bcdf245678: run_command ' +
  'and read_output, and on aws.microvm read_file, write_file, make_directory and stop_sandbox.';

/** How often a client hears that a build is still going, with or without events, in milliseconds. */
export const PROGRESS = { delay: 15000 };

const inputSchema = z.object({
  runtime: z.enum(['aws.microvm', 'aws.lambda']).optional().describe('Where it runs. Defaults to aws.microvm.'),
  image: z.string().optional().describe('A container image. Defaults to scaffoldly/sandbox.'),
  name: z.string().optional().describe("The start of the sandbox's name. Defaults to sandbox."),
  timeout: z
    .number()
    .optional()
    .describe(
      'Milliseconds before it stops, in whole seconds: 1000 to 900000 on aws.lambda, 1000 to 28800000 on aws.microvm.'
    ),
  memory: z
    .number()
    .optional()
    .describe('Megabytes: 128 to 10240 on aws.lambda; 512, 1024, 2048, 4096 or 8192 on aws.microvm.'),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe('Environment variables for every command. At most 50 on aws.microvm.'),
});

const outputSchema = z.object({
  sandbox_id: z.string().describe('Pass to get_sandbox or stop_sandbox. Its own tools need none.'),
});

export const createSandbox: Tool<SandboxFactory, typeof inputSchema, typeof outputSchema> = safeTool(
  {
    name: 'create_sandbox',
    title: 'Create sandbox',
    description:
      `Creates a sandbox to run commands in. ${OWN_TOOLS} The same options return the same sandbox, so give a ` +
      'new name for a separate one. The first sandbox for an image can take about two minutes.',
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(factory, input, ctx) {
      const { meta, layersFrom, limits, logLevel, signal } = ctx;
      const runtime = input.runtime ?? limits?.runtimes?.[0];
      // An omitted value must not pass a cap below its default.
      const timeout = input.timeout ?? (limits?.timeout && Math.min(limits.timeout, DEFAULTS.timeout));
      const memory = input.memory ?? (limits?.memory && Math.min(limits.memory, DEFAULTS.memory));

      if (runtime && limits?.runtimes && !limits.runtimes.includes(runtime)) {
        throw new RangeError(`runtime must be one of ${limits.runtimes.join(', ')}, got ${runtime}`);
      }
      if (timeout && limits?.timeout && timeout > limits.timeout) {
        throw new RangeError(`timeout must be at most ${limits.timeout} ms, got ${timeout}`);
      }
      if (memory && limits?.memory && memory > limits.memory) {
        throw new RangeError(`memory must be at most ${limits.memory} MB, got ${memory}`);
      }

      const created = factory.create({
        ...input,
        runtime,
        timeout,
        memory,
        meta,
        layersFrom,
        logLevel,
        signal,
      } as SandboxOptions);

      const progressToken = ctx.mcpReq._meta?.progressToken;

      return lastValueFrom(
        merge(
          from(created).pipe(
            map((sandbox) => {
              const result = toolResult(outputSchema, { sandbox_id: sandbox.sandboxId });
              const names = registerSandbox(sandbox, sandbox.sandboxId, ctx);
              // A client can list the new tools late, or not at all, until it hears they changed.
              if (names.length) result.content.push({ type: 'text', text: `Its tools: ${names.join(', ')}.` });
              return result;
            })
          ),
          iif(
            () => progressToken === undefined,
            EMPTY,
            merge(
              created.events().pipe(map(({ message }) => message)),
              // A build can go a while without a change, and a client may time out without progress.
              interval(PROGRESS.delay).pipe(map(() => 'Creating the sandbox'))
            )
          ).pipe(
            takeUntil(from(created)),
            concatMap((message, index) =>
              ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken, progress: index + 1, message },
              })
            ),
            // A client that can't hear progress still gets the result.
            catchError(() => EMPTY),
            ignoreElements()
          )
        )
      );
    },
  },
  describeError
);
