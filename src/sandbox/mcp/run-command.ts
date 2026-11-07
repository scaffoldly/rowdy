import {
  catchError,
  concatMap,
  EMPTY,
  finalize,
  from,
  ignoreElements,
  iif,
  interval,
  lastValueFrom,
  map,
  merge,
  race,
  switchMap,
  takeUntil,
  timer,
} from 'rxjs';
import { Writable } from 'stream';
import { z } from 'zod';
import type { SandboxFactory, SandboxToolsOptions } from '..';
import { SandboxError } from '../internal/compute';
import { toolResult, type Tool } from '../../mcp/tool';
import { PROGRESS } from './create-sandbox';

/** The most output a result carries, in bytes. */
export const OUTPUT = { limit: 64 * 1024 };

/** How long an answer waits on a command that can run on without it, in milliseconds. */
export const WAIT = { timeout: 30_000 };

const inputSchema = z.object({
  sandbox_id: z.string().describe('What create_sandbox answered with.'),
  cmd: z.string().describe('The binary to run. There is no shell: pipes and redirects need sh -c.'),
  args: z.array(z.string()).optional().describe('Its arguments.'),
  cwd: z.string().optional().describe('The working directory.'),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables, over the sandbox's own."),
  stream: z.enum(['stdout', 'stderr']).optional().describe('Keep only this in text. Defaults to both, merged.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('How long to wait before answering with the command still running. Defaults to 30000. aws.microvm only.'),
});

const outputSchema = z.object({
  cmd_id: z.string().describe('What read_output takes, to read this output again.'),
  exit_code: z
    .number()
    .nullable()
    .describe('Whatever the command exited with, or null while it runs. Not zero is still an answer.'),
  timed_out: z.boolean().describe('Whether the answer came before the command finished. It is still running.'),
  text: z.string().describe('Its output, in the order it was written.'),
  truncated: z.boolean().describe('Whether text was cut to its last 64 KiB. read_output reads the rest.'),
  total_bytes: z.number().describe('How much output there was so far, before any cut.'),
});

export const runCommand = (
  sandbox: Pick<SandboxFactory, 'get'>,
  { signal, name: scope }: SandboxToolsOptions = {}
): Tool<typeof inputSchema, typeof outputSchema> => ({
  name: 'run_command',
  title: 'Run command',
  description:
    'Runs a command in a sandbox and answers with its exit code and output. Use when you need to run something in a ' +
    'sandbox from create_sandbox. text is stdout and stderr merged in order, unless stream picks one. Long output ' +
    'keeps its last 64 KiB: truncated and total_bytes say so, and read_output reads the rest. On aws.microvm, a ' +
    'command still running after timeout_ms keeps running: the answer says timed_out, and read_output follows it.',
  inputSchema,
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async run({ sandbox_id: sandboxId, cmd, args, cwd, env, stream, timeout_ms: timeout }, ctx) {
    if (scope && !sandboxId.split(':').pop()?.startsWith(`${scope}-`)) {
      throw new SandboxError(`Not a sandbox: ${sandboxId}`);
    }
    // Only a microVM's command can run on without its caller.
    const detachable = sandboxId.includes(':microvm-image:');
    if (timeout !== undefined && !detachable) {
      throw new SandboxError('timeout_ms needs aws.microvm: on aws.lambda a command is answered when it ends.');
    }

    const found = await sandbox.get({ sandboxId, signal });
    // Only the command stops with a client's cancel: the sandbox stays for the next one.
    // Only the end is kept as it arrives: a command can print for as long as it runs.
    let text = Buffer.alloc(0);
    let totalBytes = 0;
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        totalBytes += chunk.length;
        text = Buffer.concat([text, chunk]).subarray(-OUTPUT.limit);
        callback();
      },
    });

    const params = {
      cmd,
      args,
      cwd,
      env,
      stdout: stream === 'stderr' ? undefined : output,
      stderr: stream === 'stdout' ? undefined : output,
    };

    // A client's cancel stops the wait. A detached command runs on, and only stop_sandbox or its timeout ends it.
    const following = new AbortController();
    const ran = lastValueFrom(
      detachable
        ? from(
            found.runCommand({
              ...params,
              detached: true,
              signal: AbortSignal.any([ctx.mcpReq.signal, following.signal]),
            })
          ).pipe(
            switchMap(({ cmdId, wait }) =>
              race(
                from(wait()).pipe(map(({ exitCode }) => ({ cmdId, exitCode }))),
                timer(timeout ?? WAIT.timeout).pipe(map(() => ({ cmdId, exitCode: null })))
              )
            ),
            finalize(() => following.abort())
          )
        : from(found.runCommand({ ...params, signal: ctx.mcpReq.signal }))
    );

    const progressToken = ctx.mcpReq._meta?.progressToken;
    const { cmdId, exitCode } = await lastValueFrom(
      merge(
        from(ran),
        iif(
          () => progressToken === undefined,
          EMPTY,
          // A client may time out a call that goes a while without progress.
          interval(PROGRESS.delay).pipe(
            takeUntil(from(ran)),
            concatMap((_, index) =>
              ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken, progress: index + 1, message: 'Running the command' },
              })
            ),
            // A client that can't hear progress still gets the result.
            catchError(() => EMPTY),
            ignoreElements()
          )
        )
      )
    );

    const result = toolResult(outputSchema, {
      cmd_id: cmdId,
      exit_code: exitCode,
      timed_out: exitCode === null,
      text: text.toString(),
      truncated: totalBytes > OUTPUT.limit,
      total_bytes: totalBytes,
    });

    if (result.structuredContent.timed_out) {
      result.content.push({
        type: 'text',
        text: 'Still running. Call read_output with this cmd_id and timeout_ms to follow it from the start.',
      });
    }

    if (result.structuredContent.truncated) {
      const kept = `${OUTPUT.limit / 1024} KiB of ${totalBytes} bytes`;
      result.content.push({
        type: 'text',
        text: `Output cut: showing the last ${kept}. Call read_output with this cmd_id to read from the start.`,
      });
    }

    return result;
  },
});
