import { from, lastValueFrom, map, switchMap } from 'rxjs';
import { z } from 'zod';
import type { SandboxFactory } from '../..';
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult } from '../../../mcp/internal/tool';
import type { Tool } from '../../../mcp/internal/types';
import { NOT_READY, registerSandbox } from './create-sandbox';

const inputSchema = z.object({
  sandbox_id: z.string().describe('From create_sandbox or list_sandboxes.'),
});

const outputSchema = z.object({
  sandbox_id: z.string().describe('Pass to the tools that take one. Its own tools need none.'),
  state: z
    .enum(['building', 'ready', 'failed'])
    .describe('building until it can run a command, then ready, or failed if its build failed.'),
  reason: z.string().optional().describe('Why its build failed.'),
});

export const getSandbox: Tool<SandboxFactory, typeof inputSchema, typeof outputSchema> = safeTool(
  {
    name: 'get_sandbox',
    title: 'Get sandbox',
    description:
      'Finds a sandbox that already exists, like one from list_sandboxes, says whether it is still building, ' +
      "and gives it back any tools of its own that this server adds. Doesn't start it.",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(factory, { sandbox_id: sandboxId }, ctx) {
      const { meta, logLevel, pollInterval, credentials, signal } = ctx;

      return lastValueFrom(
        from(factory.get({ sandboxId, meta, logLevel, pollInterval, credentials, signal })).pipe(
          switchMap((sandbox) =>
            from(sandbox.status()).pipe(
              map(({ state, reason }) => {
                const result = toolResult(outputSchema, { sandbox_id: sandbox.sandboxId, state, reason });
                if (state !== 'ready') result.content.push({ type: 'text', text: NOT_READY[state] });
                const names = registerSandbox(sandbox, sandbox.sandboxId, ctx);
                // A client can list the new tools late, or not at all, until it hears they changed.
                if (names.length) result.content.push({ type: 'text', text: `Its tools: ${names.join(', ')}.` });
                return result;
              })
            )
          )
        )
      );
    },
  },
  describeError
);
