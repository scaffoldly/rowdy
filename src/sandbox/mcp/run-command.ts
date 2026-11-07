import { z } from 'zod';
import type { SandboxFactory, SandboxToolsOptions } from '..';
import type { Tool } from '../../mcp/tool';

/** The most of each stream a result carries, in characters. */
export const OUTPUT = { limit: 30000 };

const inputSchema = z.object({
  sandboxId: z.string().describe('What create_sandbox answered with.'),
  cmd: z.string().describe('The binary to run. There is no shell: pipes and redirects need sh -c.'),
  args: z.array(z.string()).optional().describe('Its arguments.'),
  cwd: z.string().optional().describe('The working directory.'),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables, over the sandbox's own."),
});

const outputSchema = z.object({
  exitCode: z.number().describe('Whatever the command exited with. Not zero is still an answer.'),
  stdout: z.string().describe('What it wrote to stdout: the end of it, if truncated.'),
  stderr: z.string().describe('What it wrote to stderr: the end of it, if truncated.'),
  truncated: z
    .boolean()
    .describe('Whether either stream was cut. Narrow the command, or write to a file and read parts.'),
});

export const runCommand = (
  sandbox: Pick<SandboxFactory, 'get'>,
  { signal, name: scope }: SandboxToolsOptions = {}
): Tool<typeof inputSchema, typeof outputSchema> => ({
  name: 'run_command',
  title: 'Run command',
  description:
    'Runs a command in a sandbox and answers with its exit code and output. Use when you need to run something in a ' +
    'sandbox from create_sandbox. Output past a limit is cut from the start of each stream, and truncated says so.',
  inputSchema,
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async run({ sandboxId, cmd, args, cwd, env }, ctx) {
    if (scope && !sandboxId.split(':').pop()?.startsWith(`${scope}-`)) {
      throw new Error(`Not a sandbox: ${sandboxId}`);
    }

    const found = await sandbox.get({ sandboxId, signal });
    // Only the command stops with a client's cancel: the sandbox stays for the next one.
    const finished = await found.runCommand({ cmd, args, cwd, env, signal: ctx.mcpReq.signal });

    const stdout = await finished.stdout();
    const stderr = await finished.stderr();
    const structuredContent = {
      exitCode: finished.exitCode,
      stdout: stdout.slice(-OUTPUT.limit),
      stderr: stderr.slice(-OUTPUT.limit),
      truncated: stdout.length > OUTPUT.limit || stderr.length > OUTPUT.limit,
    };

    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  },
});
