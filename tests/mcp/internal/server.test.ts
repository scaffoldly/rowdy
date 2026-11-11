import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Environment } from '../../../src/environment';
import { serve } from '../../../src/mcp/internal/server';
import { instructions, tools } from '../../../src/mcp';

const environment = (): Environment =>
  ({
    name: '@scaffoldly/rowdy',
    version: '0.0.0',
    abort: new AbortController(),
    signal: new AbortController().signal,
  }) as unknown as Environment;

describe('serve', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers every tool and connects', async () => {
    const register = jest.spyOn(McpServer.prototype, 'registerTool');
    const connect = jest.spyOn(McpServer.prototype, 'connect').mockResolvedValue();

    await serve(environment());

    expect(register.mock.calls.map(([name]) => name)).toEqual([
      'create_sandbox',
      'get_sandbox',
      'list_sandboxes',
      'stop_sandbox',
      'delete_sandbox',
      'run_command',
      'read_output',
      'read_file',
      'write_file',
      'make_directory',
    ]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('tells a client what it is', async () => {
    const connect = jest.spyOn(McpServer.prototype, 'connect').mockResolvedValue();

    await serve(environment());

    expect((connect.mock.contexts[0] as McpServer).server['_instructions']).toBe(instructions());
  });

  it('names no tool, so tools can change without it', () => {
    Object.values(tools).forEach(({ name }) => expect(instructions()).not.toContain(name));
  });

  it('aborts when the client hangs up', async () => {
    const connect = jest.spyOn(McpServer.prototype, 'connect').mockResolvedValue();
    const { abort, ...rest } = environment();

    await serve({ ...rest, abort } as Environment);
    (connect.mock.contexts[0] as McpServer).server.onclose?.();

    expect(abort.signal.reason).toBe('MCP client disconnected');
  });
});
