import { z } from 'zod';
import type { SandboxFactory } from '../..';
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult } from '../../../mcp/internal/tool';
import type { Tool } from '../../../mcp/internal/types';

const inputSchema = z.object({
  sandbox_id: z.string().describe('From create_sandbox, get_sandbox or list_sandboxes.'),
  path: z.string().describe('Absolute, or relative to where commands start.'),
  content: z.string().describe('The whole file.'),
  encoding: z.enum(['utf8', 'base64']).optional().describe('utf8, the default, or base64 for binary.'),
  mode: z
    .string()
    .regex(/^[0-7]{3,4}$/)
    .optional()
    .describe('Octal permissions, like 755 for a script.'),
});

const outputSchema = z.object({
  path: z.string().describe('The file that was written.'),
  bytes: z.number().describe('How many bytes it holds.'),
});

export const writeFile: Tool<SandboxFactory, typeof inputSchema, typeof outputSchema> = safeTool(
  {
    name: 'write_file',
    title: 'Write file',
    description:
      'Writes a file in the sandbox, replacing any that is there and creating missing directories. Use instead of echo.',
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async run(factory, { sandbox_id: sandboxId, path, content, encoding = 'utf8', mode }, ctx) {
      const { meta, logLevel, pollInterval, credentials, signal } = ctx;
      const found = await factory.get({ sandboxId, meta, logLevel, pollInterval, credentials, signal });
      const bytes = Buffer.from(content, encoding);
      await found.writeFiles([{ path, content: bytes, mode: mode === undefined ? undefined : parseInt(mode, 8) }], {
        signal: ctx.mcpReq.signal,
      });

      return toolResult(outputSchema, { path, bytes: bytes.length });
    },
  },
  describeError
);
