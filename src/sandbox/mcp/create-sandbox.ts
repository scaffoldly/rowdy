import {
  EMPTY,
  catchError,
  from,
  ignoreElements,
  interval,
  lastValueFrom,
  map,
  merge,
  switchMap,
  takeUntil,
} from 'rxjs';
import { z } from 'zod';
import type { SandboxFactory, SandboxOptions, SandboxToolsOptions } from '..';
import { DEFAULTS } from '../internal/compute';
import type { Tool } from '../../mcp/tool';

/** How often a client hears that a build is still going, in milliseconds. */
export const PROGRESS = { delay: 15000 };

const inputSchema = z.object({
  runtime: z.enum(['aws.lambda', 'aws.microvm']).optional().describe('Where the sandbox runs.'),
  image: z.string().optional().describe('The container image to run. Defaults to scaffoldly/sandbox.'),
  name: z.string().optional().describe('The prefix of a generated name. Defaults to sandbox.'),
  timeout: z.number().optional().describe('Milliseconds until the sandbox stops, in whole seconds.'),
  memory: z.number().optional().describe('Memory in megabytes.'),
  env: z.record(z.string(), z.string()).optional().describe('Environment variables for every command.'),
});

const outputSchema = z.object({
  sandboxId: z.string().describe('What run_command and stop_sandbox take.'),
});

export const createSandbox = (
  sandbox: Pick<SandboxFactory, 'create'>,
  { logLevel, signal, name: scope, limits }: SandboxToolsOptions = {}
): Tool<typeof inputSchema, typeof outputSchema> => ({
  name: 'create_sandbox',
  title: 'Create sandbox',
  description:
    'Starts a sandbox and answers with its sandboxId. Use when you need somewhere to run commands. The same options ' +
    'answer with the same sandbox, so use a different name for one of your own. The first use of an image can take ' +
    'about two minutes. On aws.lambda, timeout is 1000 to 900000 and memory is 128 to 10240. On aws.microvm, timeout ' +
    'is 1000 to 28800000, memory is 512, 1024, 2048, 4096 or 8192, and env has at most 50 variables.',
  inputSchema,
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run(input, ctx) {
    const runtime = input.runtime ?? limits?.runtimes?.[0];
    // An omitted value must not pass a cap below its default.
    const timeout = input.timeout ?? (limits?.timeout && Math.min(limits.timeout, DEFAULTS.timeout));
    const memory = input.memory ?? (limits?.memory && Math.min(limits.memory, DEFAULTS.memory));

    if (runtime && limits?.runtimes && !limits.runtimes.includes(runtime)) {
      throw new RangeError(`runtime must be one of ${limits.runtimes.join(', ')}, got ${runtime}`);
    }
    if (timeout && limits?.timeout && timeout > limits.timeout) {
      throw new RangeError(`timeout must be at most ${limits.timeout} ms, got ${timeout}`);
    }
    if (memory && limits?.memory && memory > limits.memory) {
      throw new RangeError(`memory must be at most ${limits.memory} MB, got ${memory}`);
    }

    const created = sandbox.create({
      ...input,
      runtime,
      timeout,
      memory,
      name: [scope, input.name].filter(Boolean).join('-') || undefined,
      logLevel,
      signal,
    } as SandboxOptions);

    const progressToken = ctx.mcpReq._meta?.progressToken;

    return lastValueFrom(
      merge(
        from(created).pipe(
          map(({ sandboxId }) => ({
            content: [{ type: 'text' as const, text: JSON.stringify({ sandboxId }) }],
            structuredContent: { sandboxId },
          }))
        ),
        (progressToken === undefined ? EMPTY : interval(PROGRESS.delay)).pipe(
          takeUntil(from(created)),
          switchMap((tick) =>
            ctx.mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken, progress: tick + 1, message: 'Building the sandbox' },
            })
          ),
          // A client that can't hear progress still gets the result.
          catchError(() => EMPTY),
          ignoreElements()
        )
      )
    );
  },
});
