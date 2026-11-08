import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { Sandbox, SandboxFactory, SandboxToolsOptions } from '../../../src/sandbox';
import { SandboxError } from '../../../src/sandbox/internal/compute';
import { writeFile } from '../../../src/sandbox/mcp/write-file';

const sandboxId = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:tenant-builds-bcdf245678';

const setup = (options: SandboxToolsOptions = {}) => {
  const writeFiles = jest.fn(async (_files: unknown, _options: unknown) => undefined);
  const get = jest.fn(async (_lookup: unknown) => ({ writeFiles }) as unknown as Sandbox);
  const tool = writeFile({ get: get as unknown as SandboxFactory['get'] }, options);
  const { signal } = new AbortController();
  const run = (input: Record<string, unknown> = {}) =>
    tool.run(tool.inputSchema.parse({ sandbox_id: sandboxId, path: 'a.sh', content: 'echo hi', ...input }), {
      mcpReq: { signal },
    } as unknown as ServerContext);
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
    expect(() => setup().tool.inputSchema.parse({ sandbox_id: sandboxId, path: 'a', content: '', mode })).toThrow();
  });

  it('refuses a sandbox outside its scope', async () => {
    const { run, writeFiles } = setup({ name: 'other' });

    await expect(run()).rejects.toBeInstanceOf(SandboxError);
    expect(writeFiles).not.toHaveBeenCalled();
  });

  it('replaces what was there', () => {
    expect(setup().tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });
});
