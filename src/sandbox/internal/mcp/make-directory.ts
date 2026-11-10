import { z } from 'zod';
import type { SandboxFactory } from '../..';
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult } from '../../../mcp/internal/tool';
import type { Tool } from '../../../mcp/internal/types';

const inputSchema = z.object({
  sandbox_id: z.string().describe('From create_sandbox, get_sandbox or list_sandboxes.'),
  path: z.string().describe('Absolute, or relative to where commands start.'),
});

const outputSchema = z.object({
  path: z.string().describe('The directory that is there now.'),
});

export const makeDirectory: Tool<SandboxFactory, typeof inputSchema, typeof outputSchema> = safeTool(
  {
    name: 'make_directory',
    title: 'Make directory',
    description:
      'Creates a directory in the sandbox, with any missing parents. Fine if it exists. write_file already ' +
      'creates the directories a file needs.',
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(factory, { sandbox_id: sandboxId, path }, ctx) {
      const { meta, logLevel, pollInterval, credentials, signal } = ctx;
      const found = await factory.get({ sandboxId, meta, logLevel, pollInterval, credentials, signal });
      await found.mkDir(path, { signal: ctx.mcpReq.signal });

      return toolResult(outputSchema, { path });
    },
  },
  describeError
);
