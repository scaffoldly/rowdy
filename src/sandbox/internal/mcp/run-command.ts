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
import type { SandboxPromise } from '../..';
import { SandboxError } from '../compute';
import { describeError } from '../../../aws/errors';
import { safeTool, toolResult, type Tool } from '../../../mcp/tool';
import { PROGRESS } from './create-sandbox';

/** The most output a result carries, in bytes. */
export const OUTPUT = { limit: 64 * 1024 };

/** How long an answer waits on a command that can run on without it, in milliseconds. */
export const WAIT = { timeout: 30_000 };

const inputSchema = z.object({
  cmd: z.string().describe('The program. There is no shell: use sh -c for pipes or redirects.'),
  args: z.array(z.string()).optional().describe('Its arguments.'),
  cwd: z.string().optional().describe('The working directory.'),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables, added to the sandbox's."),
  stream: z.enum(['stdout', 'stderr']).optional().describe('Return only stdout or stderr. Defaults to both.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Milliseconds to wait before returning while it still runs. Defaults to 30000. aws.microvm only.'),
});

const outputSchema = z.object({
  cmd_id: z.string().describe('Pass to read_output to read this output again.'),
  exit_code: z.number().nullable().describe('Its exit code, or null while it runs.'),
  timed_out: z.boolean().describe('Whether this returned before the command finished.'),
  text: z.string().describe('Its output, in the order it was written.'),
  truncated: z.boolean().describe('Whether text is only the last 64 KiB.'),
  total_bytes: z.number().describe('The output size before any cut.'),
});

export const runCommand: Tool<SandboxPromise, typeof inputSchema, typeof outputSchema> = safeTool(
  {
    name: 'run_command',
    title: 'Run command',
    description:
      'Runs a command in this sandbox and returns its exit code and output, stdout and stderr merged unless ' +
      "stream picks one. Over 64 KiB, text keeps the end and truncated is set: this sandbox's read_output has " +
      'the rest. On aws.microvm, a command still running at timeout_ms keeps running and returns timed_out: ' +
      'follow it with read_output.',
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async run(sandbox, { cmd, args, cwd, env, stream, timeout_ms: timeout }, ctx) {
      const found = await sandbox;
      // Only a microVM's command can run on without its caller.
      const detachable = found.sandboxId.includes(':microvm-image:');
      if (timeout !== undefined && !detachable) {
        throw new SandboxError('timeout_ms needs aws.microvm: on aws.lambda a command is answered when it ends.');
      }

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
          text: "Still running. Call this sandbox's read_output with this cmd_id and timeout_ms to follow it from the start.",
        });
      }

      if (result.structuredContent.truncated) {
        const kept = `${OUTPUT.limit / 1024} KiB of ${totalBytes} bytes`;
        result.content.push({
          type: 'text',
          text: `Output cut: showing the last ${kept}. Call this sandbox's read_output with this cmd_id to read from the start.`,
        });
      }

      return result;
    },
  },
  describeError
);
