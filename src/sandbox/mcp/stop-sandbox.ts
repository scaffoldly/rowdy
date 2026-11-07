import { z } from 'zod';
import type { SandboxFactory, SandboxToolsOptions } from '..';
import { SandboxError } from '../internal/compute';
import { toolResult, type Tool } from '../../mcp/tool';

const inputSchema = z.object({
  sandbox_id: z.string().describe('What create_sandbox answered with.'),
});

const outputSchema = z.object({
  sandbox_id: z.string().describe('The sandbox that stopped.'),
});

export const stopSandbox = (
  sandbox: Pick<SandboxFactory, 'get'>,
  { signal, name: scope }: SandboxToolsOptions = {}
): Tool<typeof inputSchema, typeof outputSchema> => ({
  name: 'stop_sandbox',
  title: 'Stop sandbox',
  description:
    'Ends everything running in a sandbox, including a command in progress, and answers once nothing is left. Use ' +
    'when you are done with a sandbox: an aws.microvm one is billed until this or its timeout. Its files are lost, ' +
    'and the next run_command starts it again from its image. Safe to call more than once. aws.lambda sandboxes ' +
    'answer with an error, since they run nothing between commands.',
  inputSchema,
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async run({ sandbox_id: sandboxId }) {
    if (scope && !sandboxId.split(':').pop()?.startsWith(`${scope}-`)) {
      throw new SandboxError(`Not a sandbox: ${sandboxId}`);
    }

    const found = await sandbox.get({ sandboxId, signal });
    await found.stop().catch((error) => {
      // A failed stop can leave a VM running. It's billed until someone notices.
      if (error instanceof Error && !(error instanceof SandboxError)) {
        error.message = `${error.message} Part of this sandbox may still be running and billed, so retry this.`;
      }
      throw error;
    });

    return toolResult(outputSchema, { sandbox_id: sandboxId });
  },
});
