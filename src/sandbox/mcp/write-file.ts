import { z } from 'zod';
import type { SandboxFactory, SandboxToolsOptions } from '..';
import { SandboxError } from '../internal/compute';
import { toolResult, type Tool } from '../../mcp/tool';

const inputSchema = z.object({
  sandbox_id: z.string().describe('What create_sandbox answered with.'),
  path: z.string().describe('Relative to where a command starts without a cwd, unless absolute.'),
  content: z.string().describe("The file's whole content, in the encoding given."),
  encoding: z
    .enum(['utf8', 'base64'])
    .optional()
    .describe('How content is given. Defaults to utf8; use base64 for anything that is not text.'),
  mode: z
    .string()
    .regex(/^[0-7]{3,4}$/)
    .optional()
    .describe('Permissions in octal, like 755 for a script.'),
});

const outputSchema = z.object({
  path: z.string().describe('The file that was written.'),
  bytes: z.number().describe('How many bytes it holds now.'),
});

export const writeFile = (
  sandbox: Pick<SandboxFactory, 'get'>,
  { logLevel, signal, name: scope }: SandboxToolsOptions = {}
): Tool<typeof inputSchema, typeof outputSchema> => ({
  name: 'write_file',
  title: 'Write file',
  description:
    'Writes a file into a sandbox, replacing what was there, and makes its missing directories. Use to put in a ' +
    'script, a config or test input, instead of echo through run_command. aws.microvm only.',
  inputSchema,
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async run({ sandbox_id: sandboxId, path, content, encoding = 'utf8', mode }, ctx) {
    if (scope && !sandboxId.split(':').pop()?.startsWith(`${scope}-`)) {
      throw new SandboxError(`Not a sandbox: ${sandboxId}`);
    }

    const found = await sandbox.get({ sandboxId, logLevel, signal });
    const bytes = Buffer.from(content, encoding);
    await found.writeFiles([{ path, content: bytes, mode: mode === undefined ? undefined : parseInt(mode, 8) }], {
      signal: ctx.mcpReq.signal,
    });

    return toolResult(outputSchema, { path, bytes: bytes.length });
  },
});
