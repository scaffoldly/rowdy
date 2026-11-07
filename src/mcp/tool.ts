import { z } from 'zod';
import type { CallToolResult, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';

export type Tool<Input extends z.ZodObject = z.ZodObject, Output extends z.ZodObject = z.ZodObject> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  outputSchema?: Output;
  annotations?: ToolAnnotations;
  run(input: z.output<Input>, ctx: ServerContext): Promise<CallToolResult>;
};
