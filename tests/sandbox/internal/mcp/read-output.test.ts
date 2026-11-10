import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { SandboxFactory, SandboxPromise } from '../../../../src/sandbox';
import { readOutput } from '../../../../src/sandbox/internal/mcp/read-output';

const setup = () => {
  const output = jest.fn(async (_cmdId: string, _options: unknown) => ({
    text: 'out',
    cursor: '5.2',
    exitCode: 3 as number | undefined,
    dropped: false,
  }));
  const sandbox = Promise.resolve({ output }) as unknown as SandboxPromise;
  const tool = readOutput;
  const { signal } = new AbortController();
  const run = (input: Record<string, unknown> = {}) =>
    tool.run(
      { get: () => sandbox } as unknown as SandboxFactory,
      tool.inputSchema.parse({ sandbox_id: 'sandbox-bcdf245678', cmd_id: 'cmd', ...input }),
      {
        mcpReq: { signal },
      } as unknown as ServerContext
    );
  return { tool, run, output, signal };
};

describe('read_output', () => {
  it('answers with output, as text and structured content', async () => {
    const { run } = setup();

    const structuredContent = { text: 'out', cursor: '5.2', exit_code: 3, dropped: false };
    expect(await run()).toEqual({
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    });
  });

  it('leaves out an exit it has not reached', async () => {
    const { run, output } = setup();
    output.mockResolvedValueOnce({ text: '', cursor: '0.0', exitCode: undefined, dropped: false });

    expect((await run()).structuredContent).toEqual({ text: '', cursor: '0.0', dropped: false });
  });

  it('passes what to read on, with the client signal', async () => {
    const { run, output, signal } = setup();

    await run({ cursor: '5.2', stream: 'stderr', timeout_ms: 1000 });

    expect(output).toHaveBeenCalledWith('cmd', { cursor: '5.2', stream: 'stderr', timeout: 1000, signal });
  });

  it('only reads', () => {
    expect(setup().tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});
