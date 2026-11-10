import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { SandboxFactory, SandboxPromise } from '../../../../src/sandbox';
import { makeDirectory } from '../../../../src/sandbox/internal/mcp/make-directory';

const setup = () => {
  const mkDir = jest.fn(async (_path: string, _options: unknown) => undefined);
  const sandbox = Promise.resolve({ mkDir }) as unknown as SandboxPromise;
  const get = jest.fn((_lookup: unknown) => sandbox);
  const tool = makeDirectory;
  const { signal } = new AbortController();
  const run = (ctx: Record<string, unknown> = {}) =>
    tool.run(
      { get } as unknown as SandboxFactory,
      tool.inputSchema.parse({ sandbox_id: 'sandbox-bcdf245678', path: 'a/b' }),
      {
        ...ctx,
        mcpReq: { signal },
      } as unknown as ServerContext
    );
  return { tool, run, get, mkDir, signal };
};

describe('make_directory', () => {
  it('makes the directory, with the client signal', async () => {
    const { run, mkDir, signal } = setup();

    const structuredContent = { path: 'a/b' };
    expect(await run()).toEqual({
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    });
    expect(mkDir).toHaveBeenCalledWith('a/b', { signal });
  });

  it("looks the sandbox up by its sandbox_id, with the context's meta", async () => {
    const { run, get } = setup();
    const host = new AbortController();
    const credentials = async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' });

    await run({ meta: { sub: 'github:1' }, pollInterval: 15000, credentials, signal: host.signal });

    expect(get).toHaveBeenCalledWith({
      sandboxId: 'sandbox-bcdf245678',
      meta: { sub: 'github:1' },
      logLevel: undefined,
      pollInterval: 15000,
      credentials,
      signal: host.signal,
    });
  });

  it('is fine to repeat and removes nothing', () => {
    expect(setup().tool.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
  });
});
