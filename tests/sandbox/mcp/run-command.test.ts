import type { ServerContext } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { RunCommandParams, Sandbox, SandboxFactory, SandboxToolsOptions } from '../../../src/sandbox';
import { SandboxError } from '../../../src/sandbox/internal/compute';
import { PROGRESS } from '../../../src/sandbox/mcp/create-sandbox';
import { OUTPUT, runCommand, WAIT } from '../../../src/sandbox/mcp/run-command';

const sandboxId = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:tenant-builds-bcdf245678';
const lambdaId = 'arn:aws:lambda:us-east-1:123456789012:function:tenant-bcdf245678';

const setup = (
  options: SandboxToolsOptions = {},
  output: { exitCode?: number; writes?: [stream: 'stdout' | 'stderr', text: string][]; running?: boolean } = {}
) => {
  const command = jest.fn(async (params: RunCommandParams) => {
    output.writes?.forEach(([stream, text]) => params[stream]?.write(Buffer.from(text)));
    const exitCode = output.exitCode ?? 0;
    return {
      cmdId: 'cmd',
      exitCode,
      // As the SDK's: a handle no longer followed can't be waited on.
      wait: () =>
        output.running
          ? new Promise((_, reject) =>
              params.signal?.addEventListener('abort', () => reject(new Error('Exec abandoned')))
            )
          : Promise.resolve({ exitCode }),
    };
  });
  const get = jest.fn(async (_lookup: unknown) => ({ runCommand: command }) as unknown as Sandbox);
  const tool = runCommand({ get: get as unknown as SandboxFactory['get'] }, options);
  const client = new AbortController();
  const { signal } = client;
  const notify = jest.fn(async (_notification: unknown) => {});
  const run = (input: Record<string, unknown> = {}, progressToken?: string) =>
    tool.run(tool.inputSchema.parse({ sandbox_id: sandboxId, cmd: 'ls', ...input }), {
      mcpReq: { signal, notify, _meta: progressToken ? { progressToken } : undefined },
    } as unknown as ServerContext);
  return { tool, run, get, command, signal, client, notify };
};

const passed = (command: ReturnType<typeof setup>['command']) =>
  command.mock.calls[0]![0] as RunCommandParams & { detached?: boolean };

describe('run_command', () => {
  it('passes the command on', async () => {
    const { run, command } = setup();

    await run({ args: ['-l'], cwd: '/app', env: { CI: 'true' } });

    expect(command.mock.calls[0]?.[0]).toMatchObject({ cmd: 'ls', args: ['-l'], cwd: '/app', env: { CI: 'true' } });
  });

  it('answers with exit code and output, as text and structured content', async () => {
    const { run } = setup({}, { writes: [['stdout', 'out']] });

    const structuredContent = {
      cmd_id: 'cmd',
      exit_code: 0,
      timed_out: false,
      text: 'out',
      truncated: false,
      total_bytes: 3,
    };
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

    await run({ sandbox_id: lambdaId });

    expect(get).toHaveBeenCalledWith({ sandboxId: lambdaId, signal: host.signal });
    expect(passed(command).signal).toBe(signal);
    expect(passed(command).detached).toBeUndefined();
  });

  describe('returning early', () => {
    const { timeout } = WAIT;
    const { delay } = PROGRESS;
    afterEach(() => {
      WAIT.timeout = timeout;
      PROGRESS.delay = delay;
    });

    it('runs detached on a microVM, so letting go does not kill it', async () => {
      const { run, command } = setup();

      await run();

      expect(passed(command).detached).toBe(true);
    });

    it('answers with the command still running after timeout_ms, and says how to follow it', async () => {
      const { run } = setup({}, { running: true, writes: [['stdout', 'so far']] });

      const { structuredContent, content } = await run({ timeout_ms: 20 });

      expect(structuredContent).toMatchObject({ cmd_id: 'cmd', exit_code: null, timed_out: true, text: 'so far' });
      expect(content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('read_output') });
    });

    it('waits 30 seconds by default', async () => {
      expect(WAIT.timeout).toBe(30_000);
      WAIT.timeout = 20;
      const { run } = setup({}, { running: true });

      await expect(run()).resolves.toMatchObject({ structuredContent: { timed_out: true } });
    });

    it('stops following once it has answered', async () => {
      const { run, command } = setup({}, { running: true });

      await run({ timeout_ms: 20 });

      expect(passed(command).signal?.aborted).toBe(true);
    });

    it("stops following on a client's cancel", async () => {
      const { run, command, client } = setup({}, { running: true });

      const ran = run({ timeout_ms: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      client.abort();

      expect(passed(command).signal?.aborted).toBe(true);
      await expect(ran).rejects.toThrow('Exec abandoned');
    });

    it('refuses timeout_ms on Lambda, before running anything', async () => {
      const { run, command } = setup();

      await expect(run({ sandbox_id: lambdaId, timeout_ms: 1000 })).rejects.toBeInstanceOf(SandboxError);
      expect(command).not.toHaveBeenCalled();
    });

    it('sends progress while it waits', async () => {
      PROGRESS.delay = 5;
      const { run, notify } = setup({}, { running: true });

      await run({ timeout_ms: 40 }, 'token');

      expect(notify).toHaveBeenCalledWith({
        method: 'notifications/progress',
        params: { progressToken: 'token', progress: 1, message: 'Running the command' },
      });
    });

    it('sends no progress to a client that did not ask', async () => {
      PROGRESS.delay = 5;
      const { run, notify } = setup({}, { running: true });

      await run({ timeout_ms: 40 });

      expect(notify).not.toHaveBeenCalled();
    });
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

    it('tells a model how to read what was cut', async () => {
      const { run } = setup({}, { writes: [['stdout', 'x'.repeat(OUTPUT.limit + 1)]] });

      const { content } = await run();

      expect(content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('Call read_output') });
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

      await run({ sandbox_id: lambdaId });

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
