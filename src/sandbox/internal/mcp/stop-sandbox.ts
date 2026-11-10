import { z } from 'zod';
import type { SandboxFactory } from '../..';
import { SandboxError } from '../compute';
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult } from '../../../mcp/internal/tool';
import type { Tool } from '../../../mcp/internal/types';
import { REGISTERED } from './create-sandbox';

const inputSchema = z.object({
  sandbox_id: z.string().describe('From create_sandbox, get_sandbox or list_sandboxes.'),
});

const outputSchema = z.object({
  sandbox_id: z.string().describe('The sandbox that stopped.'),
});

export const stopSandbox: Tool<SandboxFactory, typeof inputSchema, typeof outputSchema> = safeTool(
  {
    name: 'stop_sandbox',
    title: 'Stop sandbox',
    description:
      "Stops a sandbox and everything running in it. Call when you're done with it. Its files are lost and " +
      'its tools are removed: get_sandbox brings them back, and its next command starts it fresh from its ' +
      "image. Safe to repeat. aws.lambda sandboxes can't be stopped.",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async run(
      factory,
      { sandbox_id: sandboxId },
      { server, signal, meta, logLevel, pollInterval, credentials, changed }
    ) {
      const sandbox = await factory.get({ sandboxId, meta, logLevel, pollInterval, credentials, signal });
      await sandbox.stop().catch((error) => {
        // A failed stop can leave a VM running. It's billed until someone notices.
        if (error instanceof Error && !(error instanceof SandboxError)) {
          error.message = `${error.message} Part of this sandbox may still be running and billed, so retry this.`;
        }
        throw error;
      });

      // Its own tools come off the server this stop came in on.
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
