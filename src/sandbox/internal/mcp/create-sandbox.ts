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
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult, type ServerContext, type Tool } from '../../../mcp/tool';

/** Each sandbox's own tools on each server, so a repeated create doesn't register them twice. */
export const REGISTERED = new WeakMap<Pick<McpServer, 'registerTool'>, Map<string, RegisteredTool[]>>();

/**
 * Registers a sandbox's own tools, named with its suffix, on the server a call came in on, once per server. Answers
 * with their names there, or none without a server.
 */
export const registerTools = (sandbox: Sandbox, { server, signal }: ServerContext): string[] => {
  if (!server) return [];
  const { sandboxId } = sandbox;
  // Named with the sandbox's suffix, so two sandboxes' tools don't clash.
  const suffix = sandboxId.split('-').pop();
  const tools = sandbox.tools();
  const names = tools.map(({ name }) => `${name}_${suffix}`);
  const onServer = REGISTERED.get(server) ?? new Map<string, RegisteredTool[]>();
  REGISTERED.set(server, onServer);
  if (onServer.has(sandboxId)) return names;

  const sandboxTools = tools.map(({ name, run, ...config }) =>
    server.registerTool(`${name}_${suffix}`, config, (args, extra) => run(args, { ...extra, server, signal }))
  );
  onServer.set(sandboxId, sandboxTools);
  // They come off when the call's signal aborts, unless a stop took them off first.
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
    async run(sandboxes, input, ctx) {
      const created = sandboxes.create(input as SandboxOptions);

      const progressToken = ctx.mcpReq._meta?.progressToken;

      return lastValueFrom(
        merge(
          from(created).pipe(
            map((found) => {
              const result = toolResult(outputSchema, { sandbox_id: found.sandboxId });
              const names = registerTools(found, ctx);
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
