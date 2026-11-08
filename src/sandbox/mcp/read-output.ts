import { z } from 'zod';
import type { SandboxFactory, SandboxToolsOptions } from '..';
import { SandboxError } from '../internal/compute';
import { toolResult, type Tool } from '../../mcp/tool';

const inputSchema = z.object({
  sandbox_id: z.string().describe('What create_sandbox answered with.'),
  cmd_id: z.string().describe('What run_command answered with.'),
  cursor: z.string().optional().describe('Where the last read stopped. Leave it out to start at the beginning.'),
  stream: z.enum(['stdout', 'stderr']).optional().describe('Keep only this in text. Defaults to both, merged.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('How long to wait for more once what is written has been read. Defaults to answering at once.'),
});

const outputSchema = z.object({
  text: z.string().describe('The output read, at most 64 KiB, in the order it was written.'),
  cursor: z.string().describe('Where this read stopped. Pass it to read on.'),
  exit_code: z.number().optional().describe('Set once the read reaches the end. Missing means there is more to read.'),
  dropped: z.boolean().describe('Whether the command printed more than its log keeps, so the rest is gone.'),
});

export const readOutput = (
  sandbox: Pick<SandboxFactory, 'get'>,
  { logLevel, signal, name: scope }: SandboxToolsOptions = {}
): Tool<typeof inputSchema, typeof outputSchema> => ({
  name: 'read_output',
  title: 'Read output',
  description:
    "Reads part of a command's output from a cursor. Use when run_command answered truncated, or to read on from a " +
    'command still running. Leave cursor out to start at the beginning. stream keeps only stdout or stderr. Answers ' +
    'at once unless timeout_ms says to wait. A log is behind a running command by up to 30 seconds, so no exit_code ' +
    'can mean only that the rest has not arrived.',
  inputSchema,
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run({ sandbox_id: sandboxId, cmd_id: cmdId, cursor, stream, timeout_ms: timeout }, ctx) {
    if (scope && !sandboxId.split(':').pop()?.startsWith(`${scope}-`)) {
      throw new SandboxError(`Not a sandbox: ${sandboxId}`);
    }

    const found = await sandbox.get({ sandboxId, logLevel, signal });
    const {
      text,
      cursor: next,
      exitCode,
      dropped,
    } = await found.output(cmdId, {
      cursor,
      stream,
      timeout,
      signal: ctx.mcpReq.signal,
    });

    return toolResult(outputSchema, { text, cursor: next, exit_code: exitCode, dropped });
  },
});
