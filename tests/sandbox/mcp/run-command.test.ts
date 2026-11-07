import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { RunCommandParams, Sandbox, SandboxFactory, SandboxToolsOptions } from '../../../src/sandbox';
import { OUTPUT, runCommand } from '../../../src/sandbox/mcp/run-command';

const sandboxId = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:tenant-builds-bcdf245678';

const setup = (
  options: SandboxToolsOptions = {},
  output: { exitCode?: number; stdout?: string; stderr?: string } = {}
) => {
  const finished = {
    exitCode: output.exitCode ?? 0,
    stdout: async () => output.stdout ?? '',
    stderr: async () => output.stderr ?? '',
  };
  const command = jest.fn(async (_params: RunCommandParams) => finished);
  const get = jest.fn(async (_lookup: unknown) => ({ runCommand: command }) as unknown as Sandbox);
  const tool = runCommand({ get: get as unknown as SandboxFactory['get'] }, options);
  const { signal } = new AbortController();
  const run = (input: Record<string, unknown> = {}) =>
    tool.run(tool.inputSchema.parse({ sandboxId, cmd: 'ls', ...input }), {
      mcpReq: { signal },
    } as unknown as ServerContext);
  return { tool, run, get, command, signal };
};

describe('run_command', () => {
  it('passes the command on', async () => {
    const { run, command } = setup();

    await run({ args: ['-l'], cwd: '/app', env: { CI: 'true' } });

    expect(command.mock.calls[0]?.[0]).toMatchObject({ cmd: 'ls', args: ['-l'], cwd: '/app', env: { CI: 'true' } });
  });

  it('answers with exit code and output, as text and structured content', async () => {
    const { run } = setup({}, { stdout: 'out', stderr: 'err' });

    const structuredContent = { exitCode: 0, stdout: 'out', stderr: 'err', truncated: false };
    expect(await run()).toEqual({
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    });
  });

  it('answers normally for a command that fails', async () => {
    const { run } = setup({}, { exitCode: 2, stderr: 'no such file' });

    const result = await run();

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ exitCode: 2, stderr: 'no such file' });
  });

  it('rejects when the command could not run', async () => {
    const { run, command } = setup();
    command.mockRejectedValue(new Error('Sandbox stopped'));

    await expect(run()).rejects.toThrow('Sandbox stopped');
  });

  it("gives the host's signal to the sandbox, and the client's to the command", async () => {
    const host = new AbortController();
    const { run, get, command, signal } = setup({ signal: host.signal });

    await run();

    expect(get).toHaveBeenCalledWith({ sandboxId, signal: host.signal });
    expect(command.mock.calls[0]?.[0].signal).toBe(signal);
  });

  describe('output limit', () => {
    it('keeps the end of a stream over the limit, and says so', async () => {
      const { run } = setup({}, { stdout: `start${'x'.repeat(OUTPUT.limit)}` });

      const { structuredContent } = await run();

      expect(structuredContent).toMatchObject({ stdout: 'x'.repeat(OUTPUT.limit), truncated: true });
    });

    it('says so for stderr too', async () => {
      const { run } = setup({}, { stderr: 'x'.repeat(OUTPUT.limit + 1) });

      expect((await run()).structuredContent).toMatchObject({ truncated: true });
    });

    it('leaves output at the limit alone', async () => {
      const { run } = setup({}, { stdout: 'x'.repeat(OUTPUT.limit) });

      expect((await run()).structuredContent).toMatchObject({ truncated: false });
    });
  });

  describe('scope', () => {
    it('allows a sandbox in the scope', async () => {
      const { run, get } = setup({ name: 'tenant' });

      await run();

      expect(get).toHaveBeenCalled();
    });

    it('allows a Lambda sandbox in the scope', async () => {
      const { run, get } = setup({ name: 'tenant' });

      await run({ sandboxId: 'arn:aws:lambda:us-east-1:123456789012:function:tenant-bcdf245678' });

      expect(get).toHaveBeenCalled();
    });

    it('refuses a sandbox outside it', async () => {
      const { run, get } = setup({ name: 'other' });

      await expect(run()).rejects.toThrow('Not a sandbox');
      expect(get).not.toHaveBeenCalled();
    });

    it('needs the whole name, not just its start', async () => {
      const { run, get } = setup({ name: 'ten' });

      await expect(run()).rejects.toThrow('Not a sandbox');
      expect(get).not.toHaveBeenCalled();
    });

    it('takes any sandbox without a scope', async () => {
      const { run, get } = setup();

      await run();

      expect(get).toHaveBeenCalled();
    });
  });
});
