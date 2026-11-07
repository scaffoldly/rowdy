import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { RunCommandParams, Sandbox, SandboxFactory, SandboxToolsOptions } from '../../../src/sandbox';
import { OUTPUT, runCommand } from '../../../src/sandbox/mcp/run-command';

const sandboxId = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:tenant-builds-bcdf245678';

const setup = (
  options: SandboxToolsOptions = {},
  output: { exitCode?: number; writes?: [stream: 'stdout' | 'stderr', text: string][] } = {}
) => {
  const command = jest.fn(async (params: RunCommandParams) => {
    output.writes?.forEach(([stream, text]) => params[stream]?.write(Buffer.from(text)));
    return { exitCode: output.exitCode ?? 0 };
  });
  const get = jest.fn(async (_lookup: unknown) => ({ runCommand: command }) as unknown as Sandbox);
  const tool = runCommand({ get: get as unknown as SandboxFactory['get'] }, options);
  const { signal } = new AbortController();
  const run = (input: Record<string, unknown> = {}) =>
    tool.run(tool.inputSchema.parse({ sandbox_id: sandboxId, cmd: 'ls', ...input }), {
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
    const { run } = setup({}, { writes: [['stdout', 'out']] });

    const structuredContent = { exit_code: 0, text: 'out', truncated: false, total_bytes: 3 };
    expect(await run()).toEqual({
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    });
  });

  it('keeps stdout and stderr in the order they were written', async () => {
    const { run } = setup(
      {},
      {
        writes: [
          ['stdout', 'one '],
          ['stderr', 'two '],
          ['stdout', 'three'],
        ],
      }
    );

    expect((await run()).structuredContent).toMatchObject({ text: 'one two three' });
  });

  it.each([
    ['stdout', 'out'],
    ['stderr', 'err'],
  ])('keeps only %s when asked', async (stream, text) => {
    const { run } = setup(
      {},
      {
        writes: [
          ['stdout', 'out'],
          ['stderr', 'err'],
        ],
      }
    );

    expect((await run({ stream })).structuredContent).toMatchObject({ text });
  });

  it('answers normally for a command that fails', async () => {
    const { run } = setup({}, { exitCode: 2, writes: [['stderr', 'no such file']] });

    const result = await run();

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ exit_code: 2, text: 'no such file' });
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
    it('keeps the end of output over the limit, and says so', async () => {
      const { run } = setup({}, { writes: [['stdout', `start${'x'.repeat(OUTPUT.limit)}`]] });

      const { structuredContent } = await run();

      expect(structuredContent).toMatchObject({
        text: 'x'.repeat(OUTPUT.limit),
        truncated: true,
        total_bytes: OUTPUT.limit + 5,
      });
    });

    it('holds no more than the limit while a command prints', async () => {
      const { limit } = OUTPUT;
      OUTPUT.limit = 8;
      const { run } = setup(
        {},
        {
          writes: [
            ['stdout', 'aaaaaaaa'],
            ['stdout', 'bbbb'],
            ['stderr', 'cc'],
          ],
        }
      );

      expect((await run()).structuredContent).toMatchObject({ text: 'aabbbbcc', truncated: true, total_bytes: 14 });
      OUTPUT.limit = limit;
    });

    it('counts only the stream it keeps', async () => {
      const { run } = setup(
        {},
        {
          writes: [
            ['stdout', 'out'],
            ['stderr', 'err!'],
          ],
        }
      );

      expect((await run({ stream: 'stdout' })).structuredContent).toMatchObject({ total_bytes: 3 });
    });

    it('counts both streams together', async () => {
      const half = 'x'.repeat(OUTPUT.limit / 2 + 1);
      const { run } = setup(
        {},
        {
          writes: [
            ['stdout', half],
            ['stderr', half],
          ],
        }
      );

      expect((await run()).structuredContent).toMatchObject({ truncated: true });
    });

    it('leaves output at the limit alone', async () => {
      const { run } = setup({}, { writes: [['stdout', 'x'.repeat(OUTPUT.limit)]] });

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

      await run({ sandbox_id: 'arn:aws:lambda:us-east-1:123456789012:function:tenant-bcdf245678' });

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
