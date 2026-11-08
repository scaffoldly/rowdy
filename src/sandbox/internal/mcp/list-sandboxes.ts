import { z } from 'zod';
import type { SandboxFactory } from '../..';
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult } from '../../../mcp/internal/tool';
import type { Tool } from '../../../mcp/internal/types';

const inputSchema = z.object({
  runtime: z.enum(['aws.microvm', 'aws.lambda']).optional().describe('Only sandboxes on this runtime.'),
});

const outputSchema = z.object({
  sandboxes: z.array(
    z.object({
      sandbox_id: z.string().describe('Pass to get_sandbox or stop_sandbox.'),
      name: z.string(),
      runtime: z.enum(['aws.microvm', 'aws.lambda']),
      running: z.boolean().optional().describe('Whether its microVM is up. Missing on aws.lambda.'),
      started_at: z.string().optional().describe('When the microVM started.'),
      stops_at: z.string().optional().describe("When the microVM's timeout stops it."),
    })
  ),
});

export const listSandboxes: Tool<SandboxFactory, typeof inputSchema, typeof outputSchema> = safeTool(
  {
    name: 'list_sandboxes',
    title: 'List sandboxes',
    description: 'Lists sandboxes and whether each is running. To work in one, call get_sandbox with its sandbox_id.',
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(sandboxes, { runtime }, { meta, limits, signal }) {
      const found = (await sandboxes.list({ runtime, meta, signal }))
        // A runtime the host doesn't allow isn't one a model can use.
        .filter((each) => !limits?.runtimes || limits.runtimes.includes(each.runtime));

      return toolResult(outputSchema, {
        sandboxes: found.map(({ sandboxId, name, runtime: on, running, startedAt, stopsAt }) => ({
          sandbox_id: sandboxId,
          name,
          runtime: on,
          running,
          started_at: startedAt?.toISOString(),
          stops_at: stopsAt?.toISOString(),
        })),
      });
    },
  },
  describeError
);
