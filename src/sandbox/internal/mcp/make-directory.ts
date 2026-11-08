import { z } from 'zod';
import type { SandboxPromise } from '../..';
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult, type Tool } from '../../../mcp/tool';

const inputSchema = z.object({
  path: z.string().describe('Absolute, or relative to where commands start.'),
});

const outputSchema = z.object({
  path: z.string().describe('The directory that is there now.'),
});

export const makeDirectory: Tool<SandboxPromise, typeof inputSchema, typeof outputSchema> = safeTool(
  {
    name: 'make_directory',
    title: 'Make directory',
    description:
      'Creates a directory in this sandbox, with any missing parents. Fine if it exists. write_file already ' +
      'creates the directories a file needs.',
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(sandbox, { path }, ctx) {
      const found = await sandbox;
      await found.mkDir(path, { signal: ctx.mcpReq.signal });

      return toolResult(outputSchema, { path });
    },
  },
  describeError
);
