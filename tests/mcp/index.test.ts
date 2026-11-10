import { describe, expect, it, jest } from '@jest/globals';
import type { SandboxFactory, ServerContext } from '@scaffoldly/rowdy/sandbox';
import * as mcp from '@scaffoldly/rowdy/mcp';

describe('tools', () => {
  it('has every tool, keyed by its own name', () => {
    expect(Object.keys(mcp.tools)).toEqual([
      'create_sandbox',
      'get_sandbox',
      'list_sandboxes',
      'stop_sandbox',
      'run_command',
      'read_output',
      'read_file',
      'write_file',
      'make_directory',
    ]);
    Object.entries(mcp.tools).forEach(([key, { name }]) => expect(key).toBe(name));
  });

  it('takes the sandbox_id of the sandbox each acts on', () => {
    (['stop_sandbox', 'run_command', 'read_output', 'read_file', 'write_file', 'make_directory'] as const).forEach(
      (name) => expect(mcp.tools[name].inputSchema.shape).toHaveProperty('sandbox_id')
    );
  });
});

describe('registerTools', () => {
  const tool = { name: 'run_command', title: '', description: '', inputSchema: {} as never, run: jest.fn() };
  const setup = () => {
    const list = jest.fn(async (options: { runtime?: string }) =>
      [
        { sandboxId: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:a-bcdf2', runtime: 'aws.microvm' },
        { sandboxId: 'arn:aws:lambda:us-east-1:123456789012:function:b-ghjk4', runtime: 'aws.lambda' },
      ].filter(({ runtime }) => !options.runtime || runtime === options.runtime)
    );
    const get = jest.fn((_lookup: unknown) => ({ tools: () => [tool] }));
    const registerTool = jest.fn((_name: string, _config: unknown, _run: unknown) => ({ remove: () => {} }));
    const factory = { list, get } as unknown as SandboxFactory;
    return { list, get, registerTool, factory };
  };

  it("registers every sandbox with the context's meta, on its runtimes", async () => {
    const { list, get, registerTool, factory } = setup();
    const meta = { sub: 'github:1' };
    const credentials = async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' });

    const names = await mcp.registerTools(factory, {
      server: { registerTool },
      meta,
      pollInterval: 15000,
      credentials,
      limits: { runtimes: ['aws.microvm'] },
    } as unknown as ServerContext);

    expect(names).toEqual(['run_command_bcdf2']);
    expect(list.mock.calls).toEqual([[{ runtime: 'aws.microvm', meta, credentials, signal: undefined }]]);
    expect(get).toHaveBeenCalledWith({
      sandboxId: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:a-bcdf2',
      meta,
      logLevel: undefined,
      pollInterval: 15000,
      credentials,
      signal: undefined,
    });
    expect(registerTool.mock.calls.map(([name]) => name)).toEqual(['run_command_bcdf2']);
  });

  it('lists every runtime when the host allows any', async () => {
    const { list, registerTool, factory } = setup();

    const names = await mcp.registerTools(factory, { server: { registerTool } } as unknown as ServerContext);

    expect(list.mock.calls).toEqual([[{ runtime: undefined, meta: undefined, signal: undefined }]]);
    expect(names).toEqual(['run_command_bcdf2', 'run_command_ghjk4']);
  });

  it('lists nothing without a server', async () => {
    const { list, factory } = setup();

    expect(await mcp.registerTools(factory, {} as ServerContext)).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });
});
