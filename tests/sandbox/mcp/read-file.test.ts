import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { ReadFile, Sandbox, SandboxFactory, SandboxToolsOptions } from '../../../src/sandbox';
import { SandboxError } from '../../../src/sandbox/internal/compute';
import { readFile } from '../../../src/sandbox/mcp/read-file';

const sandboxId = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:tenant-builds-bcdf245678';

const setup = (file: Buffer | null = Buffer.from('hello'), options: SandboxToolsOptions = {}) => {
  // Answers the range asked for, as the runtime does.
  const readFileToBuffer = jest.fn(
    async ({ offset = 0, length }: ReadFile, _options: unknown) =>
      file && file.subarray(offset, length === undefined ? undefined : offset + length)
  );
  const get = jest.fn(async (_lookup: unknown) => ({ readFileToBuffer }) as unknown as Sandbox);
  const tool = readFile({ get: get as unknown as SandboxFactory['get'] }, options);
  const { signal } = new AbortController();
  const run = (input: Record<string, unknown> = {}) =>
    tool.run(tool.inputSchema.parse({ sandbox_id: sandboxId, path: 'a.txt', ...input }), {
      mcpReq: { signal },
    } as unknown as ServerContext);
  return { tool, run, readFileToBuffer, signal };
};

describe('read_file', () => {
  it('answers with the content, as text and structured content', async () => {
    const { run } = setup();

    const structuredContent = { found: true, content: 'hello', encoding: 'utf8', truncated: false };
    expect(await run()).toEqual({
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    });
  });

  it('asks for one byte past 64 KiB from offset, with the client signal', async () => {
    const { run, readFileToBuffer, signal } = setup();

    await run({ cwd: '/work', offset: 10 });

    expect(readFileToBuffer).toHaveBeenCalledWith(
      { path: 'a.txt', cwd: '/work', offset: 10, length: 64 * 1024 + 1 },
      { signal }
    );
  });

  it('answers found: false for a missing file', async () => {
    const { run } = setup(null);

    expect((await run()).structuredContent).toEqual({
      found: false,
      content: '',
      encoding: 'utf8',
      truncated: false,
    });
  });

  it('gives bytes back in base64', async () => {
    const { run } = setup(Buffer.from([0, 255, 1]));

    expect((await run({ encoding: 'base64' })).structuredContent).toMatchObject({
      content: 'AP8B',
      encoding: 'base64',
    });
  });

  it('reads 64 KiB at a time, on from offset', async () => {
    const { run } = setup(Buffer.alloc(64 * 1024 + 10, 'a'));

    const first = (await run()).structuredContent as { content: string; truncated: boolean };
    const rest = (await run({ offset: 64 * 1024 })).structuredContent as { content: string; truncated: boolean };

    expect(first.content).toHaveLength(64 * 1024);
    expect(first.truncated).toBe(true);
    expect(rest).toMatchObject({ content: 'a'.repeat(10), truncated: false });
  });

  it('is not truncated at exactly 64 KiB', async () => {
    const { run } = setup(Buffer.alloc(64 * 1024, 'a'));

    expect((await run()).structuredContent).toMatchObject({ truncated: false });
  });

  it('refuses a sandbox outside its scope', async () => {
    const { run, readFileToBuffer } = setup(Buffer.from(''), { name: 'other' });

    await expect(run()).rejects.toBeInstanceOf(SandboxError);
    expect(readFileToBuffer).not.toHaveBeenCalled();
  });

  it('only reads', () => {
    expect(setup().tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});
