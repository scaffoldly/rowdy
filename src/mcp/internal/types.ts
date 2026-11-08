import type { z } from 'zod';
import type {
  CallToolResult,
  McpServer,
  ServerContext as McpServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import type { SandboxToolsOptions } from '../../sandbox';

/** The MCP SDK's context for a call, with what the host gives it: its server, signal, scope and limits. */
export type ServerContext = McpServerContext &
  SandboxToolsOptions & {
    /** Where `create_sandbox` registers each new sandbox's own tools. */
    server?: Pick<McpServer, 'registerTool'>;
    /** The host's, for as long as what a call starts may run. Aborting it takes the tools it registered off `server`. */
    signal?: AbortSignal;
  };

export type Tool<Sdk = unknown, Input extends z.ZodObject = z.ZodObject, Output extends z.ZodObject = z.ZodObject> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  outputSchema?: Output;
  annotations?: ToolAnnotations;
  run(
    sdk: Sdk,
    input: z.output<Input>,
    ctx: ServerContext
  ): Promise<CallToolResult & { structuredContent: z.output<Output> }>;
};

/** A tool given its SDK, as a server registers it, and called with the server it's on. */
export type BoundTool = Omit<Tool, 'run'> & {
  run(input: z.output<z.ZodObject>, ctx: ServerContext): Promise<CallToolResult>;
};

/** What a model should do about a failure, if there's anything to say. */
export type ToolFailure = { message: string; remedy?: 'retry' | 'ask' | 'none' };
