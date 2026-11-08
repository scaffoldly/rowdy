import type { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { inspect } from 'util';
import { log } from '../../log';
import type { Tool, ToolFailure } from './types';

/** A tool's answer, checked against its schema, as structured content and as text. */
export const toolResult = <Output extends z.ZodObject>(
  schema: Output,
  structuredContent: z.output<Output>
): CallToolResult & { structuredContent: z.output<Output> } => {
  const parsed = schema.parse(structuredContent);
  return { content: [{ type: 'text', text: JSON.stringify(parsed) }], structuredContent: parsed };
};

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
