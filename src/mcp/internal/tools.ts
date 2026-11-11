import { z } from 'zod';
import type { SandboxFactory, SandboxToolsOptions } from '../../sandbox';
import { DEFAULTS, MICROVM_MEMORY } from '../../sandbox/internal/compute';
import { createSandbox } from '../../sandbox/internal/mcp/create-sandbox';
import { deleteSandbox } from '../../sandbox/internal/mcp/delete-sandbox';
import { getSandbox } from '../../sandbox/internal/mcp/get-sandbox';
import { listSandboxes } from '../../sandbox/internal/mcp/list-sandboxes';
import { makeDirectory } from '../../sandbox/internal/mcp/make-directory';
import { readFile } from '../../sandbox/internal/mcp/read-file';
import { readOutput } from '../../sandbox/internal/mcp/read-output';
import { runCommand } from '../../sandbox/internal/mcp/run-command';
import { stopSandbox } from '../../sandbox/internal/mcp/stop-sandbox';
import { writeFile } from '../../sandbox/internal/mcp/write-file';
import type { Tool } from './types';

export type ToolName =
  | 'create_sandbox'
  | 'get_sandbox'
  | 'list_sandboxes'
  | 'stop_sandbox'
  | 'delete_sandbox'
  | 'run_command'
  | 'read_output'
  | 'read_file'
  | 'write_file'
  | 'make_directory';

/** What the tools' text is said for. */
export type ToolsOptions = Pick<SandboxToolsOptions, 'limits'>;

// What AWS allows each runtime, in milliseconds and megabytes.
const RUNTIMES = {
  'aws.microvm': { timeout: 28_800_000, memory: MICROVM_MEMORY as readonly number[] },
  'aws.lambda': { timeout: 900_000, memory: [128, 10240] as readonly number[] },
};

// What the text says, on the runtimes the host allows, within its caps.
const allowed = ({ limits }: ToolsOptions) => {
  const runtimes = limits?.runtimes?.length ? limits.runtimes : (['aws.microvm', 'aws.lambda'] as const);
  const timeout = (runtime: keyof typeof RUNTIMES): number =>
    Math.min(RUNTIMES[runtime].timeout, limits?.timeout ?? Infinity);
  const longest = Math.max(...runtimes.map(timeout));
  const lasting = (ms: number): string => {
    const [hours, minutes] = [ms / 3_600_000, ms / 60_000];
    if (Number.isInteger(hours)) return hours === 1 ? 'an hour' : `${hours} hours`;
    if (Number.isInteger(minutes)) return minutes === 1 ? 'a minute' : `${minutes} minutes`;
    return `${ms / 1000} seconds`;
  };
  return {
    runtimes,
    microvm: runtimes.includes('aws.microvm'),
    lambda: runtimes.includes('aws.lambda'),
    // Each part of the text per runtime, joined, and named only when there's more than one.
    each: (part: (runtime: keyof typeof RUNTIMES) => string, separator = ', '): string =>
      runtimes.length === 1
        ? part(runtimes[0]!)
        : runtimes.map((runtime) => `${part(runtime)} on ${runtime}`).join(separator),
    timeout,
    memory: (runtime: keyof typeof RUNTIMES): string => {
      const cap = limits?.memory ?? Infinity;
      if (runtime === 'aws.lambda') return `128 to ${Math.min(10240, cap)}`;
      const sizes = MICROVM_MEMORY.filter((size) => size <= cap);
      return sizes.length > 1 ? `${sizes.slice(0, -1).join(', ')} or ${sizes[sizes.length - 1]}` : `${sizes[0]}`;
    },
    lifetime: `It lasts ${lasting(Math.min(DEFAULTS.timeout, longest))} unless its timeout says otherwise, at most ${lasting(longest)}.`,
  };
};

/**
 * rowdy's tools, keyed by name, with their text and inputs said for a host's `limits`: only the runtimes in
 * `limits.runtimes`, and their ranges within `limits.timeout` and `limits.memory`. With no `aws.microvm`, the tools only
 * it has are left out. What each tool accepts is still checked as the limits on each call say, whatever the text.
 */
export const tools = (options: ToolsOptions = {}): Partial<Record<ToolName, Tool<SandboxFactory>>> => {
  const { runtimes, microvm, lambda, each, timeout, memory, lifetime } = allowed(options);
  const runtime =
    runtimes.length > 1
      ? z
          .enum(runtimes as [string, ...string[]])
          .optional()
          .describe(`Where it runs. Defaults to ${runtimes[0]}.`)
      : undefined;
  const narrowed = (schema: z.ZodObject): z.ZodObject =>
    runtime ? schema.extend({ runtime }) : schema.omit({ runtime: true });

  return {
    create_sandbox: {
      ...createSandbox,
      description: `${createSandbox.description} ${lifetime}`,
      inputSchema: narrowed(
        createSandbox.inputSchema.extend({
          timeout: createSandbox.inputSchema.shape.timeout.describe(
            `Milliseconds before it stops, in whole seconds: ${each((on) => `1000 to ${timeout(on)}`)}.`
          ),
          memory: createSandbox.inputSchema.shape.memory.describe(`Megabytes: ${each(memory, '; ')}.`),
          env: createSandbox.inputSchema.shape.env.describe(
            `Environment variables for every command.${microvm ? (lambda ? ' At most 50 on aws.microvm.' : ' At most 50.') : ''}`
          ),
        })
      ),
    } as Tool<SandboxFactory>,
    get_sandbox: getSandbox,
    list_sandboxes: {
      ...listSandboxes,
      inputSchema: runtime
        ? listSandboxes.inputSchema.extend({
            runtime: z
              .enum(runtimes as [string, ...string[]])
              .optional()
              .describe('Only sandboxes on this runtime.'),
          })
        : listSandboxes.inputSchema.omit({ runtime: true }),
    } as Tool<SandboxFactory>,
    ...(microvm && {
      stop_sandbox: {
        ...stopSandbox,
        description: lambda
          ? stopSandbox.description
          : stopSandbox.description.replace(" aws.lambda sandboxes can't be stopped.", ''),
      },
    }),
    delete_sandbox: deleteSandbox,
    run_command: {
      ...runCommand,
      description: !microvm
        ? runCommand.description.replace(/ On aws\.microvm, .*$/, '')
        : lambda
          ? runCommand.description
          : runCommand.description.replace('On aws.microvm, a command', 'A command'),
      inputSchema: microvm
        ? runCommand.inputSchema.extend({
            timeout_ms: runCommand.inputSchema.shape.timeout_ms.describe(
              `Milliseconds to wait before returning while it still runs. Defaults to 30000.${lambda ? ' aws.microvm only.' : ''}`
            ),
          })
        : runCommand.inputSchema.omit({ timeout_ms: true }),
    } as Tool<SandboxFactory>,
    read_output: readOutput,
    ...(microvm && { read_file: readFile, write_file: writeFile, make_directory: makeDirectory }),
  };
};
