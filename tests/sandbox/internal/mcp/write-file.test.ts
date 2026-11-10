import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { SandboxFactory, SandboxPromise } from '../../../../src/sandbox';
import { writeFile } from '../../../../src/sandbox/internal/mcp/write-file';

const setup = () => {
  const writeFiles = jest.fn(async (_files: unknown, _options: unknown) => undefined);
  const sandbox = Promise.resolve({ writeFiles }) as unknown as SandboxPromise;
  const tool = writeFile;
  const { signal } = new AbortController();
  const run = (input: Record<string, unknown> = {}) =>
    tool.run(
      { get: () => sandbox } as unknown as SandboxFactory,
      tool.inputSchema.parse({ sandbox_id: 'sandbox-bcdf245678', path: 'a.sh', content: 'echo hi', ...input }),
      {
        mcpReq: { signal },
      } as unknown as ServerContext
    );
  return { tool, run, writeFiles, signal };
};

describe('write_file', () => {
  it('writes the content, with the client signal', async () => {
    const { run, writeFiles, signal } = setup();

    const structuredContent = { path: 'a.sh', bytes: 7 };
    expect(await run()).toEqual({
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    });
    expect(writeFiles).toHaveBeenCalledWith([{ path: 'a.sh', content: Buffer.from('echo hi'), mode: undefined }], {
      signal,
    });
  });

  it('takes base64 and an octal mode', async () => {
    const { run, writeFiles } = setup();

    await run({ content: 'AP8B', encoding: 'base64', mode: '755' });

    expect(writeFiles).toHaveBeenCalledWith([{ path: 'a.sh', content: Buffer.from([0, 255, 1]), mode: 0o755 }], {
      signal: expect.anything(),
    });
  });

  it.each(['rwx', '8', '75555'])('refuses a mode that is not octal: %j', (mode) => {
    expect(() => setup().tool.inputSchema.parse({ path: 'a', content: '', mode })).toThrow();
  });

  it('replaces what was there', () => {
    expect(setup().tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });
});
