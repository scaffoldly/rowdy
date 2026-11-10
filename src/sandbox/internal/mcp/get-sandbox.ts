import { from, lastValueFrom, map } from 'rxjs';
import { z } from 'zod';
import type { SandboxFactory } from '../..';
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult } from '../../../mcp/internal/tool';
import type { Tool } from '../../../mcp/internal/types';
import { OWN_TOOLS, registerSandbox } from './create-sandbox';

const inputSchema = z.object({
  sandbox_id: z.string().describe('From create_sandbox or list_sandboxes.'),
});

const outputSchema = z.object({
  sandbox_id: z.string().describe('Pass to stop_sandbox. Its own tools need none.'),
});

export const getSandbox: Tool<SandboxFactory, typeof inputSchema, typeof outputSchema> = safeTool(
  {
    name: 'get_sandbox',
    title: 'Get sandbox',
    description:
      "Gives a sandbox that already exists, like one from list_sandboxes, its tools again when you don't have " +
      `them. ${OWN_TOOLS} Doesn't start it.`,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(factory, { sandbox_id: sandboxId }, ctx) {
      const { meta, logLevel, pollInterval, credentials, signal } = ctx;

      return lastValueFrom(
        from(factory.get({ sandboxId, meta, logLevel, pollInterval, credentials, signal })).pipe(
          map((sandbox) => {
            const result = toolResult(outputSchema, { sandbox_id: sandbox.sandboxId });
            const names = registerSandbox(sandbox, sandbox.sandboxId, ctx);
            // A client can list the new tools late, or not at all, until it hears they changed.
            if (names.length) result.content.push({ type: 'text', text: `Its tools: ${names.join(', ')}.` });
            return result;
          })
        )
      );
    },
  },
  describeError
);
