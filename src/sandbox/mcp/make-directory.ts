import { z } from 'zod';
import type { SandboxFactory, SandboxToolsOptions } from '..';
import { SandboxError } from '../internal/compute';
import { toolResult, type Tool } from '../../mcp/tool';

const inputSchema = z.object({
  sandbox_id: z.string().describe('What create_sandbox answered with.'),
  path: z.string().describe('Relative to where a command starts without a cwd, unless absolute.'),
});

const outputSchema = z.object({
  path: z.string().describe('The directory that is there now.'),
});

export const makeDirectory = (
  sandbox: Pick<SandboxFactory, 'get'>,
  { logLevel, signal, name: scope }: SandboxToolsOptions = {}
): Tool<typeof inputSchema, typeof outputSchema> => ({
  name: 'make_directory',
  title: 'Make directory',
  description:
    'Makes a directory in a sandbox, with its parents, and is fine if it is already there. write_file makes the ' +
    'directories a file needs, so this is only for an empty one. aws.microvm only.',
  inputSchema,
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run({ sandbox_id: sandboxId, path }, ctx) {
    if (scope && !sandboxId.split(':').pop()?.startsWith(`${scope}-`)) {
      throw new SandboxError(`Not a sandbox: ${sandboxId}`);
    }

    const found = await sandbox.get({ sandboxId, logLevel, signal });
    await found.mkDir(path, { signal: ctx.mcpReq.signal });

    return toolResult(outputSchema, { path });
  },
});
