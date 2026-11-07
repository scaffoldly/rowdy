import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Environment } from '../../src/environment';
import { serve } from '../../src/mcp/server';

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

    expect(register.mock.calls.map(([name]) => name)).toEqual(['create_sandbox', 'run_command', 'stop_sandbox']);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('aborts when the client hangs up', async () => {
    const connect = jest.spyOn(McpServer.prototype, 'connect').mockResolvedValue();
    const { abort, ...rest } = environment();

    await serve({ ...rest, abort } as Environment);
    (connect.mock.contexts[0] as McpServer).server.onclose?.();

    expect(abort.signal.reason).toBe('MCP client disconnected');
  });
});
