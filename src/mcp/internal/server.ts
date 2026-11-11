import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Environment } from '../../environment';
import { Sandbox } from '../../sandbox';
import { instructions, tools } from '..';

/** Serves rowdy's tools over stdio, until the client hangs up. */
export const serve = ({ name, version, abort, signal }: Environment): Promise<void> => {
  const server = new McpServer({ name, version }, { instructions: instructions() });

  Object.values(tools).forEach(({ name, run, ...config }) =>
    server.registerTool(name, config, (input, ctx) => run(Sandbox, input, { ...ctx, server, signal }))
  );
  server.server.onclose = (): void => abort.abort('MCP client disconnected');

  return server.connect(new StdioServerTransport());
};
