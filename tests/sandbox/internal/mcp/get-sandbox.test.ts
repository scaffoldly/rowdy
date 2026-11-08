import { describe, expect, it, jest } from '@jest/globals';
import type { BoundTool, Sandbox, SandboxFactory, SandboxPromise, ServerContext } from '../../../../src/sandbox';
import { getSandbox } from '../../../../src/sandbox/internal/mcp/get-sandbox';

const sandboxId = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:builds-bcdf245678';

const setup = () => {
  const own = jest.fn(async (_args: unknown, _ctx: unknown) => ({ content: [] }));
  const tools = (): BoundTool[] => [
    { name: 'run_command', title: '', description: '', inputSchema: {} as never, run: own },
  ];
  const get = jest.fn(
    (_lookup: unknown) => Promise.resolve({ sandboxId, tools } as unknown as Sandbox) as unknown as SandboxPromise
  );
  const sandboxes = { get } as unknown as SandboxFactory;
  const removed: string[] = [];
  const registerTool = jest.fn((name: string, _config: unknown, _run: unknown) => ({
    remove: () => void removed.push(name),
  }));
  const run = (ctx: Partial<ServerContext> = {}) =>
    getSandbox.run(sandboxes, getSandbox.inputSchema.parse({ sandbox_id: sandboxId }), ctx as ServerContext);
  return { run, get, registerTool, removed, own };
};

describe('get_sandbox', () => {
  it('looks the sandbox up and answers with it', async () => {
    const { run, get } = setup();

    expect((await run()).structuredContent).toEqual({ sandbox_id: sandboxId });
    expect(get).toHaveBeenCalledWith({ sandboxId });
  });

  it("registers the sandbox's own tools on the call's server, once", async () => {
    const { run, registerTool } = setup();
    const server = { registerTool } as unknown as ServerContext['server'];

    await run({ server });
    await run({ server });

    expect(registerTool.mock.calls.map(([name]) => name)).toEqual(['run_command_bcdf245678']);
  });

  it('names the tools it registered in its answer, every time', async () => {
    const { run, registerTool } = setup();
    const server = { registerTool } as unknown as ServerContext['server'];

    await run({ server });
    const { content } = await run({ server });

    expect(content[1]).toEqual({ type: 'text', text: 'Its tools: run_command_bcdf245678.' });
  });

  it('says nothing more without a server', async () => {
    const { run } = setup();

    expect((await run()).content).toHaveLength(1);
  });

  it("gives those tools the server and signal, and takes them off when the call's signal aborts", async () => {
    const { run, registerTool, removed, own } = setup();
    const server = { registerTool } as unknown as ServerContext['server'];
    const host = new AbortController();

    await run({ server, signal: host.signal });
    const [, , registered] = registerTool.mock.calls[0]!;
    await (registered as (args: unknown, extra: object) => Promise<unknown>)({}, {});
    host.abort();

    expect(own).toHaveBeenCalledWith({}, { server, signal: host.signal });
    expect(removed).toEqual(['run_command_bcdf245678']);
  });

  it('says the tools changed when it registers them, and not when they were there', async () => {
    const { run, registerTool } = setup();
    const server = { registerTool } as unknown as ServerContext['server'];
    const changed = jest.fn();

    await run({ server, changed });
    await run({ server, changed });

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('registers nothing without a server', async () => {
    const { run, registerTool } = setup();

    await run();

    expect(registerTool).not.toHaveBeenCalled();
  });

  it('changes nothing in the sandbox', () => {
    expect(getSandbox.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
  });
});
