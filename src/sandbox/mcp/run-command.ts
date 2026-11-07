import { Writable } from 'stream';
import { z } from 'zod';
import type { SandboxFactory, SandboxToolsOptions } from '..';
import type { Tool } from '../../mcp/tool';

/** The most output a result carries, in bytes. */
export const OUTPUT = { limit: 64 * 1024 };

const inputSchema = z.object({
  sandbox_id: z.string().describe('What create_sandbox answered with.'),
  cmd: z.string().describe('The binary to run. There is no shell: pipes and redirects need sh -c.'),
  args: z.array(z.string()).optional().describe('Its arguments.'),
  cwd: z.string().optional().describe('The working directory.'),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables, over the sandbox's own."),
});

const outputSchema = z.object({
  exit_code: z.number().describe('Whatever the command exited with. Not zero is still an answer.'),
  text: z.string().describe('Its stdout and stderr together, in the order they were written.'),
  truncated: z
    .boolean()
    .describe('Whether text was cut to its last 64 KiB. Narrow the command, or write to a file and read parts.'),
});

export const runCommand = (
  sandbox: Pick<SandboxFactory, 'get'>,
  { signal, name: scope }: SandboxToolsOptions = {}
): Tool<typeof inputSchema, typeof outputSchema> => ({
  name: 'run_command',
  title: 'Run command',
  description:
    'Runs a command in a sandbox and answers with its exit code and output. Use when you need to run something in a ' +
    'sandbox from create_sandbox. Stderr is mixed in with stdout: redirect it to keep it apart.',
  inputSchema,
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async run({ sandbox_id: sandboxId, cmd, args, cwd, env }, ctx) {
    if (scope && !sandboxId.split(':').pop()?.startsWith(`${scope}-`)) {
      throw new Error(`Not a sandbox: ${sandboxId}`);
    }

    const found = await sandbox.get({ sandboxId, signal });
    // Only the command stops with a client's cancel: the sandbox stays for the next one.
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback): void {
        chunks.push(chunk);
        callback();
      },
    });

    const { exitCode } = await found.runCommand({
      cmd,
      args,
      cwd,
      env,
      stdout: output,
      stderr: output,
      signal: ctx.mcpReq.signal,
    });

    const text = Buffer.concat(chunks);
    const structuredContent = {
      exit_code: exitCode,
      text: text.subarray(-OUTPUT.limit).toString(),
      truncated: text.length > OUTPUT.limit,
    };

    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  },
});
