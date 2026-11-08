import { describe, expect, it } from '@jest/globals';
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
