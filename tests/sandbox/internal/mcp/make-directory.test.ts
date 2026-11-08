import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { SandboxPromise } from '../../../../src/sandbox';
import { makeDirectory } from '../../../../src/sandbox/internal/mcp/make-directory';

const setup = () => {
  const mkDir = jest.fn(async (_path: string, _options: unknown) => undefined);
  const sandbox = Promise.resolve({ mkDir }) as unknown as SandboxPromise;
  const tool = makeDirectory;
  const { signal } = new AbortController();
  const run = () =>
    tool.run(sandbox, tool.inputSchema.parse({ path: 'a/b' }), {
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

  it('is fine to repeat and removes nothing', () => {
    expect(setup().tool.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
  });
});
