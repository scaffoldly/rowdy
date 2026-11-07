import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Environment } from '../environment';
import { Sandbox } from '../sandbox';

/** Serves rowdy's tools over stdio, until the client hangs up. */
export const serve = ({ name, version, abort, signal }: Environment): Promise<void> => {
  const server = new McpServer({ name, version });

  Sandbox.tools({ signal }).forEach(({ name, run, ...config }) => server.registerTool(name, config, run));
  server.server.onclose = (): void => abort.abort('MCP client disconnected');

  return server.connect(new StdioServerTransport());
};
