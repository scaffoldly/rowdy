import { z } from 'zod';
import type { SandboxFactory } from '../..';
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult } from '../../../mcp/internal/tool';
import type { Tool } from '../../../mcp/internal/types';
import { REGISTERED } from './create-sandbox';

const inputSchema = z.object({
  sandbox_id: z.string().describe('From create_sandbox, get_sandbox or list_sandboxes.'),
});

const outputSchema = z.object({
  sandbox_id: z.string().describe('The sandbox that was deleted.'),
});

export const deleteSandbox: Tool<SandboxFactory, typeof inputSchema, typeof outputSchema> = safeTool(
  {
    name: 'delete_sandbox',
    title: 'Delete sandbox',
    description:
      "Deletes a sandbox for good: it stops, and it's gone from list_sandboxes, with its files and its commands' " +
      'output. create_sandbox with the same options makes a new one, from scratch. Safe to repeat.',
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async run(
      factory,
      { sandbox_id: sandboxId },
      { server, signal, meta, logLevel, pollInterval, credentials, changed }
    ) {
      await factory.delete({ sandboxId, meta, logLevel, pollInterval, credentials, signal });

      // Its own tools come off the server this delete came in on.
      const onServer = server && REGISTERED.get(server);
      const sandboxTools = onServer?.get(sandboxId);
      sandboxTools?.forEach((tool) => tool.remove());
      onServer?.delete(sandboxId);
      if (sandboxTools) changed?.();

      return toolResult(outputSchema, { sandbox_id: sandboxId });
    },
  },
  describeError
);
