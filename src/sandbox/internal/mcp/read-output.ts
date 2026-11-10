import { z } from 'zod';
import type { SandboxFactory } from '../..';
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult } from '../../../mcp/internal/tool';
import type { Tool } from '../../../mcp/internal/types';

const inputSchema = z.object({
  sandbox_id: z.string().describe('From create_sandbox, get_sandbox or list_sandboxes.'),
  cmd_id: z.string().describe('From run_command.'),
  cursor: z.string().optional().describe('Where the last read stopped. Leave it out to start at the beginning.'),
  stream: z.enum(['stdout', 'stderr']).optional().describe('Return only stdout or stderr. Defaults to both.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Milliseconds to wait for more after reading what's there. Defaults to none."),
});

const outputSchema = z.object({
  text: z.string().describe('Up to 64 KiB of output, in the order it was written.'),
  cursor: z.string().describe('Pass back to read on.'),
  exit_code: z.number().optional().describe('Set once the read reaches the end.'),
  dropped: z.boolean().describe('Whether output was lost because the command printed more than its log keeps.'),
});

export const readOutput: Tool<SandboxFactory, typeof inputSchema, typeof outputSchema> = safeTool(
  {
    name: 'read_output',
    title: 'Read output',
    description:
      "Reads a command's output from a cursor. Use when run_command was truncated or timed out. Returns at " +
      'once unless timeout_ms says to wait for more. Output can lag a running command by up to 30 seconds, so ' +
      "a missing exit_code may only mean the rest hasn't arrived.",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(factory, { sandbox_id: sandboxId, cmd_id: cmdId, cursor, stream, timeout_ms: timeout }, ctx) {
      const { meta, logLevel, pollInterval, credentials, signal } = ctx;
      const found = await factory.get({ sandboxId, meta, logLevel, pollInterval, credentials, signal });
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
  },
  describeError
);
