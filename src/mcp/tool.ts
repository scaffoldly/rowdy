import { z } from 'zod';
import type {
  CallToolResult,
  McpServer,
  ServerContext as McpServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { inspect } from 'util';
import { log } from '../log';

/** The MCP SDK's context for a call, with the server it came in on where the host gives it. */
export type ServerContext = McpServerContext & {
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

/** A tool's answer, checked against its schema, as structured content and as text. */
export const toolResult = <Output extends z.ZodObject>(
  schema: Output,
  structuredContent: z.output<Output>
): CallToolResult & { structuredContent: z.output<Output> } => {
  const parsed = schema.parse(structuredContent);
  return { content: [{ type: 'text', text: JSON.stringify(parsed) }], structuredContent: parsed };
};

/** What a model should do about a failure, if there's anything to say. */
export type ToolFailure = { message: string; remedy?: 'retry' | 'ask' | 'none' };

const REMEDIES = {
  retry: 'Retrying may help.',
  ask: "Retrying won't help: tell the person.",
  none: "Retrying won't help.",
};

// Errors already made safe, so a tool wrapping another passes them on as they are.
const SAFE = new WeakSet<Error>();

/** A tool whose errors are safe for a model to read, with what to do next. The whole error is logged. */
export const safeTool = <Sdk, Input extends z.ZodObject, Output extends z.ZodObject>(
  tool: Tool<Sdk, Input, Output>,
  describe: (error: unknown) => ToolFailure
): Tool<Sdk, Input, Output> => ({
  ...tool,
  run: (sdk, input, ctx) =>
    tool.run(sdk, input, ctx).catch((error) => {
      if (error instanceof Error && SAFE.has(error)) throw error;
      log.child('mcp').warn('Tool Failed', { tool: tool.name, error: inspect(error) });
      const { message, remedy } = describe(error);
      const safe = new Error(remedy ? `${message} ${REMEDIES[remedy]}` : message);
      SAFE.add(safe);
      throw safe;
    }),
});
