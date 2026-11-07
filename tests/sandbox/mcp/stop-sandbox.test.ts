import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { Sandbox, SandboxFactory, SandboxToolsOptions } from '../../../src/sandbox';
import { SandboxError } from '../../../src/sandbox/internal/compute';
import { stopSandbox } from '../../../src/sandbox/mcp/stop-sandbox';

const sandboxId = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:tenant-builds-bcdf245678';

const setup = (options: SandboxToolsOptions = {}) => {
  const stop = jest.fn(async () => {});
  const get = jest.fn(async (_lookup: unknown) => ({ stop }) as unknown as Sandbox);
  const tool = stopSandbox({ get: get as unknown as SandboxFactory['get'] }, options);
  const run = (id = sandboxId) => tool.run(tool.inputSchema.parse({ sandbox_id: id }), {} as ServerContext);
  return { run, get, stop };
};

describe('stop_sandbox', () => {
  it('stops the sandbox and answers with it', async () => {
    const { run, stop } = setup();

    const structuredContent = { sandbox_id: sandboxId };
    expect(await run()).toEqual({
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("passes the host's signal on", async () => {
    const { signal } = new AbortController();
    const { run, get } = setup({ signal });

    await run();

    expect(get).toHaveBeenCalledWith({ sandboxId, signal });
  });

  it('rejects when a sandbox can not stop', async () => {
    const { run, stop } = setup();
    stop.mockRejectedValue(new SandboxError('stop is not implemented on runtime aws.lambda'));

    await expect(run()).rejects.toThrow(/^stop is not implemented on runtime aws\.lambda$/);
  });

  it('says a failed stop may have left something running', async () => {
    const { run, stop } = setup();
    stop.mockRejectedValue(new Error('Throttled.'));

    await expect(run()).rejects.toThrow('Part of this sandbox may still be running and billed, so retry this.');
  });

  it('refuses a sandbox outside the scope', async () => {
    const { run, get } = setup({ name: 'other' });

    await expect(run()).rejects.toThrow('Not a sandbox');
    expect(get).not.toHaveBeenCalled();
  });

  it('allows a sandbox in the scope', async () => {
    const { run, stop } = setup({ name: 'tenant' });

    await run();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});
