import { z } from 'zod';
import type { SandboxPromise } from '../..';
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult } from '../../../mcp/internal/tool';
import type { Tool } from '../../../mcp/internal/types';
import { OUTPUT } from './run-command';

const inputSchema = z.object({
  path: z.string().describe('Absolute, or relative to cwd.'),
  cwd: z.string().optional().describe('Where a relative path starts. Defaults to where commands start.'),
  encoding: z.enum(['utf8', 'base64']).optional().describe('utf8, the default, or base64 for binary.'),
  offset: z.number().int().min(0).optional().describe('The byte to start at. Defaults to 0.'),
});

const outputSchema = z.object({
  found: z.boolean().describe('Whether the file exists.'),
  content: z.string().describe('Up to 64 KiB, in the encoding asked for.'),
  encoding: z.enum(['utf8', 'base64']),
  truncated: z.boolean().describe('Whether the file goes on: read on with a larger offset.'),
});

export const readFile: Tool<SandboxPromise, typeof inputSchema, typeof outputSchema> = safeTool(
  {
    name: 'read_file',
    title: 'Read file',
    description:
      'Reads a file in this sandbox, up to 64 KiB per call: read on with offset. Use instead of cat. A ' +
      'missing file returns found: false.',
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(sandbox, { path, cwd, encoding = 'utf8', offset = 0 }, ctx) {
      const found = await sandbox;
      // One byte past the limit says whether there's more.
      const file = await found.readFileToBuffer(
        { path, cwd, offset, length: OUTPUT.limit + 1 },
        { signal: ctx.mcpReq.signal }
      );

      return toolResult(outputSchema, {
        found: file !== null,
        content: (file?.subarray(0, OUTPUT.limit) ?? Buffer.alloc(0)).toString(encoding),
        encoding,
        truncated: !!file && file.length > OUTPUT.limit,
      });
    },
  },
  describeError
);
