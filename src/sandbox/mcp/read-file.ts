import { z } from 'zod';
import type { SandboxFactory, SandboxToolsOptions } from '..';
import { SandboxError } from '../internal/compute';
import { toolResult, type Tool } from '../../mcp/tool';
import { OUTPUT } from './run-command';

const inputSchema = z.object({
  sandbox_id: z.string().describe('What create_sandbox answered with.'),
  path: z.string().describe('Relative to cwd, or to where a command starts without one, unless absolute.'),
  cwd: z.string().optional().describe('Where a relative path starts.'),
  encoding: z
    .enum(['utf8', 'base64'])
    .optional()
    .describe('How content is given back. Defaults to utf8; use base64 for anything that is not text.'),
  offset: z.number().int().min(0).optional().describe('The byte to start at. Defaults to 0.'),
});

const outputSchema = z.object({
  found: z.boolean().describe('Whether the file is there. Missing is an answer, not an error.'),
  content: z.string().describe('The bytes read, at most 64 KiB, in the encoding asked for.'),
  encoding: z.enum(['utf8', 'base64']),
  truncated: z.boolean().describe('Whether the file goes on past this read. Read on with offset.'),
});

export const readFile = (
  sandbox: Pick<SandboxFactory, 'get'>,
  { logLevel, signal, name: scope }: SandboxToolsOptions = {}
): Tool<typeof inputSchema, typeof outputSchema> => ({
  name: 'read_file',
  title: 'Read file',
  description:
    'Reads a file from a sandbox, 64 KiB at a time from offset. Use to read a config or a result a command wrote, ' +
    'instead of cat through run_command. A missing file answers found: false. aws.microvm only.',
  inputSchema,
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run({ sandbox_id: sandboxId, path, cwd, encoding = 'utf8', offset = 0 }, ctx) {
    if (scope && !sandboxId.split(':').pop()?.startsWith(`${scope}-`)) {
      throw new SandboxError(`Not a sandbox: ${sandboxId}`);
    }

    const found = await sandbox.get({ sandboxId, logLevel, signal });
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
});
