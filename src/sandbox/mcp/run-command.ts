import { Writable } from 'stream';
import { z } from 'zod';
import type { SandboxFactory, SandboxToolsOptions } from '..';
import { SandboxError } from '../internal/compute';
import { toolResult, type Tool } from '../../mcp/tool';

/** The most output a result carries, in bytes. */
export const OUTPUT = { limit: 64 * 1024 };

const inputSchema = z.object({
  sandbox_id: z.string().describe('What create_sandbox answered with.'),
  cmd: z.string().describe('The binary to run. There is no shell: pipes and redirects need sh -c.'),
  args: z.array(z.string()).optional().describe('Its arguments.'),
  cwd: z.string().optional().describe('The working directory.'),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables, over the sandbox's own."),
  stream: z.enum(['stdout', 'stderr']).optional().describe('Keep only this in text. Defaults to both, merged.'),
});

const outputSchema = z.object({
  exit_code: z.number().describe('Whatever the command exited with. Not zero is still an answer.'),
  text: z.string().describe('Its output, in the order it was written.'),
  truncated: z
    .boolean()
    .describe('Whether text was cut to its last 64 KiB. Narrow the command, or write to a file and read parts.'),
  total_bytes: z.number().describe('How much output there was, before any cut.'),
});

export const runCommand = (
  sandbox: Pick<SandboxFactory, 'get'>,
  { signal, name: scope }: SandboxToolsOptions = {}
): Tool<typeof inputSchema, typeof outputSchema> => ({
  name: 'run_command',
  title: 'Run command',
  description:
    'Runs a command in a sandbox and answers with its exit code and output. Use when you need to run something in a ' +
    'sandbox from create_sandbox. Stderr is mixed in with stdout unless stream picks one.',
  inputSchema,
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async run({ sandbox_id: sandboxId, cmd, args, cwd, env, stream }, ctx) {
    if (scope && !sandboxId.split(':').pop()?.startsWith(`${scope}-`)) {
      throw new SandboxError(`Not a sandbox: ${sandboxId}`);
    }

    const found = await sandbox.get({ sandboxId, signal });
    // Only the command stops with a client's cancel: the sandbox stays for the next one.
    // Only the end is kept as it arrives: a command can print for as long as it runs.
    let text = Buffer.alloc(0);
    let totalBytes = 0;
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        totalBytes += chunk.length;
        text = Buffer.concat([text, chunk]).subarray(-OUTPUT.limit);
        callback();
      },
    });

    const { exitCode } = await found.runCommand({
      cmd,
      args,
      cwd,
      env,
      stdout: stream === 'stderr' ? undefined : output,
      stderr: stream === 'stdout' ? undefined : output,
      signal: ctx.mcpReq.signal,
    });

    return toolResult(outputSchema, {
      exit_code: exitCode,
      text: text.toString(),
      truncated: totalBytes > OUTPUT.limit,
      total_bytes: totalBytes,
    });
  },
});
