import { describe, expect, it, jest } from '@jest/globals';
import type { SandboxFactory, ServerContext } from '@scaffoldly/rowdy/sandbox';
import * as mcp from '@scaffoldly/rowdy/mcp';

describe('tools', () => {
  it('has the tools a server starts with', () => {
    expect(Object.keys(mcp.tools.factory)).toEqual(['create_sandbox', 'get_sandbox', 'list_sandboxes', 'stop_sandbox']);
  });

  it('has the tools each sandbox gets', () => {
    expect(Object.keys(mcp.tools.lazy)).toEqual([
      'run_command',
      'read_output',
      'read_file',
      'write_file',
      'make_directory',
    ]);
  });

  it('keys each tool by its own name', () => {
    [mcp.tools.factory, mcp.tools.lazy].forEach((group) =>
      Object.entries(group).forEach(([key, { name }]) => expect(key).toBe(name))
    );
  });
});

describe('registerTools', () => {
  const tool = { name: 'run_command', title: '', description: '', inputSchema: {} as never, run: jest.fn() };
  const setup = () => {
    const list = jest.fn(async (_options: unknown) => [
      { sandboxId: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:a-bcdf2', runtime: 'aws.microvm' },
      { sandboxId: 'arn:aws:lambda:us-east-1:123456789012:function:b-ghjk4', runtime: 'aws.lambda' },
    ]);
    const get = jest.fn((_lookup: unknown) => ({ tools: () => [tool] }));
    const registerTool = jest.fn((_name: string, _config: unknown, _run: unknown) => ({ remove: () => {} }));
    const factory = { list, get } as unknown as SandboxFactory;
    return { list, get, registerTool, factory };
  };

  it("registers every sandbox with the context's meta, on its runtimes", async () => {
    const { list, get, registerTool, factory } = setup();
    const meta = { sub: 'github:1' };

    const names = await mcp.registerTools(factory, {
      server: { registerTool },
      meta,
      pollInterval: 15000,
      limits: { runtimes: ['aws.microvm'] },
    } as unknown as ServerContext);

    expect(names).toEqual(['run_command_bcdf2']);
    expect(list).toHaveBeenCalledWith({ meta, signal: undefined });
    expect(get).toHaveBeenCalledWith({
      sandboxId: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:a-bcdf2',
      meta,
      logLevel: undefined,
      pollInterval: 15000,
      signal: undefined,
    });
    expect(registerTool.mock.calls.map(([name]) => name)).toEqual(['run_command_bcdf2']);
  });

  it('lists nothing without a server', async () => {
    const { list, factory } = setup();

    expect(await mcp.registerTools(factory, {} as ServerContext)).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });
});
