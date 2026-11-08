import { z } from 'zod';
import type { CallToolResult, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import { inspect } from 'util';
import { log } from '../log';

export type Tool<Input extends z.ZodObject = z.ZodObject, Output extends z.ZodObject = z.ZodObject> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  outputSchema?: Output;
  annotations?: ToolAnnotations;
  run(input: z.output<Input>, ctx: ServerContext): Promise<CallToolResult & { structuredContent: z.output<Output> }>;
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

/** A tool whose errors are safe for a model to read, with what to do next. The whole error is logged. */
export const safeTool = (tool: Tool, describe: (error: unknown) => ToolFailure): Tool => ({
  ...tool,
  run: (input, ctx) =>
    tool.run(input, ctx).catch((error) => {
      log.child('mcp').warn('Tool Failed', { tool: tool.name, error: inspect(error) });
      const { message, remedy } = describe(error);
      throw new Error(remedy ? `${message} ${REMEDIES[remedy]}` : message);
    }),
});
