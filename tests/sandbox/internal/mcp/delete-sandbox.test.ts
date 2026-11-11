import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { SandboxFactory } from '../../../../src/sandbox';
import { deleteSandbox } from '../../../../src/sandbox/internal/mcp/delete-sandbox';
import { REGISTERED } from '../../../../src/sandbox/internal/mcp/create-sandbox';

const sandboxId = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:builds-bcdf245678';

const setup = (ctx: Record<string, unknown> = {}) => {
  const remove = jest.fn(async (_lookup: unknown) => {});
  const tool = deleteSandbox;
  const sandboxes = { delete: remove } as unknown as SandboxFactory;
  const run = (id = sandboxId) =>
    tool.run(sandboxes, tool.inputSchema.parse({ sandbox_id: id }), ctx as unknown as ServerContext);
  return { run, remove };
};

describe('delete_sandbox', () => {
  it('deletes the sandbox and answers with it', async () => {
    const { run, remove } = setup();

    const structuredContent = { sandbox_id: sandboxId };
    expect(await run()).toEqual({
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("looks the sandbox up by its id, with the context's meta", async () => {
    const { run, remove } = setup({ meta: { sub: 'github:1' } });

    await run();

    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ sandboxId, meta: { sub: 'github:1' } }));
  });

  it('takes its own tools off the server, and says so', async () => {
    const server = { registerTool: jest.fn() } as unknown as Pick<McpServer, 'registerTool'>;
    const removed: string[] = [];
    REGISTERED.set(server, new Map([[sandboxId, [{ remove: () => removed.push('run_command_bcdf245678') }] as never]]));
    const changed = jest.fn();
    const { run } = setup({ server, changed });

    await run();

    expect(removed).toEqual(['run_command_bcdf245678']);
    expect(REGISTERED.get(server)?.has(sandboxId)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('is destructive, and fine to repeat', () => {
    expect(deleteSandbox.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
  });
});
