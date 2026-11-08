import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { Sandbox, SandboxFactory, SandboxToolsOptions } from '../../../src/sandbox';
import { SandboxError } from '../../../src/sandbox/internal/compute';
import { makeDirectory } from '../../../src/sandbox/mcp/make-directory';

const sandboxId = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:tenant-builds-bcdf245678';

const setup = (options: SandboxToolsOptions = {}) => {
  const mkDir = jest.fn(async (_path: string, _options: unknown) => undefined);
  const get = jest.fn(async (_lookup: unknown) => ({ mkDir }) as unknown as Sandbox);
  const tool = makeDirectory({ get: get as unknown as SandboxFactory['get'] }, options);
  const { signal } = new AbortController();
  const run = () =>
    tool.run(tool.inputSchema.parse({ sandbox_id: sandboxId, path: 'a/b' }), {
      mcpReq: { signal },
    } as unknown as ServerContext);
  return { tool, run, mkDir, signal };
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

  it('refuses a sandbox outside its scope', async () => {
    const { run, mkDir } = setup({ name: 'other' });

    await expect(run()).rejects.toBeInstanceOf(SandboxError);
    expect(mkDir).not.toHaveBeenCalled();
  });

  it('is fine to repeat and removes nothing', () => {
    expect(setup().tool.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
  });
});
