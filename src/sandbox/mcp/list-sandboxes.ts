import { z } from 'zod';
import type { SandboxFactory, SandboxToolsOptions } from '..';
import { toolResult, type Tool } from '../../mcp/tool';

const inputSchema = z.object({
  runtime: z.enum(['aws.microvm', 'aws.lambda']).optional().describe('Only sandboxes on this runtime.'),
});

const outputSchema = z.object({
  sandboxes: z.array(
    z.object({
      sandbox_id: z.string().describe('What run_command, read_output and stop_sandbox take.'),
      name: z.string(),
      runtime: z.enum(['aws.microvm', 'aws.lambda']),
      running: z
        .boolean()
        .optional()
        .describe('Whether a microVM is up, and billed. Missing on aws.lambda, billed only while a command runs.'),
      started_at: z.string().optional().describe('When the running microVM started.'),
      stops_at: z.string().optional().describe('When its timeout ends the running microVM, unless stop_sandbox does.'),
    })
  ),
});

export const listSandboxes = (
  sandbox: Pick<SandboxFactory, 'list'>,
  { signal, name: scope, limits }: SandboxToolsOptions = {}
): Tool<typeof inputSchema, typeof outputSchema> => ({
  name: 'list_sandboxes',
  title: 'List sandboxes',
  description:
    "Lists sandboxes, and which are running. Use to find a sandbox_id you've lost, or to see what's billed: a " +
    'running aws.microvm sandbox is billed until stop_sandbox or stops_at.',
  inputSchema,
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run({ runtime }) {
    const found = await sandbox.list({ runtime, name: scope, signal });

    return toolResult(outputSchema, {
      sandboxes: found
        // A runtime the host doesn't allow isn't one a model can use.
        .filter((each) => !limits?.runtimes || limits.runtimes.includes(each.runtime))
        .map(({ sandboxId, name, runtime: on, running, startedAt, stopsAt }) => ({
          sandbox_id: sandboxId,
          name,
          runtime: on,
          running,
          started_at: startedAt?.toISOString(),
          stops_at: stopsAt?.toISOString(),
        })),
    });
  },
});
