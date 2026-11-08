import { describe, expect, it } from '@jest/globals';
import * as mcp from '@scaffoldly/rowdy/mcp';

describe('tools', () => {
  it('has the tools a server starts with', () => {
    expect(mcp.tools.factory.map(({ name }) => name)).toEqual([
      'create_sandbox',
      'get_sandbox',
      'list_sandboxes',
      'stop_sandbox',
    ]);
  });

  it('has the tools each sandbox gets', () => {
    expect(mcp.tools.sandbox.map(({ name }) => name)).toEqual([
      'run_command',
      'read_output',
      'read_file',
      'write_file',
      'make_directory',
    ]);
  });
});
