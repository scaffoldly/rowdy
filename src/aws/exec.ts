import { CloudWatchLogsClient, paginateFilterLogEvents, StartLiveTailCommand } from '@aws-sdk/client-cloudwatch-logs';
import { gunzipSync, gzipSync } from 'zlib';
import {
  concatMap,
  defer,
  delay,
  EMPTY,
  endWith,
  filter,
  finalize,
  from,
  fromEvent,
  ignoreElements,
  lastValueFrom,
  map,
  merge,
  NEVER,
  Observable,
  OperatorFunction,
  reduce,
  ReplaySubject,
  scan,
  share,
  switchMap,
  take,
  takeUntil,
  takeWhile,
  tap,
} from 'rxjs';
import { Exec, ExecFinished, ExecFrame, ExecOutput, ExecOutputOptions } from '../api/types';
import { EXEC_LOG, EXEC_STREAM } from '../proxy/frames';
import type { ShellExit } from '../proxy/shell';
import type { AwsSandboxOptions } from '../sandbox';
import { SandboxError } from '../sandbox/internal/compute';

/** The most of each stream a command's handle keeps, in bytes. A command can print for as long as it runs. */
export const RETAINED = { bytes: 1024 * 1024 };

/** Docker-style frames from a stream of bytes: a frame can span chunks, and a chunk can hold several frames. */
export const framesOf = (): OperatorFunction<Uint8Array, ExecFrame> => (chunks) =>
  defer(() => {
    let buffer = Buffer.alloc(0);
    return chunks.pipe(
      concatMap((chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const decoded: ExecFrame[] = [];
        while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt32BE(4)) {
          const size = buffer.readUInt32BE(4);
          decoded.push({ stream: buffer.readUInt8(0), payload: Buffer.from(buffer.subarray(8, 8 + size)) });
          buffer = buffer.subarray(8 + size);
        }
        return decoded;
      })
    );
  });

/**
 * A command's handle over its frames, emitted once, completing with them. Unsubscribing stops waiting and fails the
 * handle; the command runs on until it exits or times out.
 */
export const execOf = (cmdId: () => string, source: Observable<ExecFrame>): Observable<Exec> =>
  new Observable<Exec>((subscriber) => {
    // Only a subscriber that's late to a running command needs these.
    const frames = new ReplaySubject<ExecFrame>(32);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let exit: ShellExit | undefined;

    const exec: Exec = {
      get cmdId() {
        return cmdId();
      },
      get exitCode() {
        return exit?.code;
      },
      get truncated() {
        return truncated;
      },
      frames: frames.asObservable(),
      stdout: async () => stdout.toString(),
      stderr: async () => stderr.toString(),
      wait: () =>
        lastValueFrom(
          frames.pipe(
            ignoreElements(),
            endWith(undefined),
            map(() => {
              if (!exit) {
                throw new Error('Command ended without an exit');
              }
              const finished: ExecFinished = { ...exec, exitCode: exit.code, wait: async () => finished };
              return finished;
            })
          )
        ),
    };

    subscriber.next(exec);

    const subscription = source
      .pipe(
        tap(({ stream, payload }) => {
          if (stream === EXEC_STREAM.STDOUT) stdout = Buffer.concat([stdout, payload]);
          if (stream === EXEC_STREAM.STDERR) stderr = Buffer.concat([stderr, payload]);
          truncated ||= stdout.length > RETAINED.bytes || stderr.length > RETAINED.bytes;
          stdout = stdout.subarray(-RETAINED.bytes);
          stderr = stderr.subarray(-RETAINED.bytes);
          if (stream === EXEC_STREAM.EXIT) exit = JSON.parse(payload.toString());
        })
      )
      .subscribe({
        next: (frame) => frames.next(frame),
        error: (error) => {
          frames.error(error);
          subscriber.error(error);
        },
        complete: () => {
          frames.complete();
          subscriber.complete();
        },
      });

    return () => {
      subscription.unsubscribe();
      frames.error(new Error('Exec abandoned'));
    };
  });

/**
 * Where a command's output is in its sandbox's log: the sandbox, the day and version its log stream is named after, the
 * VM or instance that ran it, and the command's own id. Nothing of the account's, which a log group's ARN would carry.
 */
export type CmdLocator = { sandbox: string; day: string; version: string; vm: string; exec: string };

const CMD_URL = /^rowdy:\/\/exec\/([\w.-]+)\/(\d{4}\/\d{2}\/\d{2})\/([\w.$]+)\/([\w-]+)\/([\w-]+)$/;

/** A command's id, `rowdy://exec/{sandbox}/{day}/{version}/{vm}/{exec}`, gzipped and base64url-encoded. */
export const CmdId = {
  stringify: ({ sandbox, day, version, vm, exec }: CmdLocator): string =>
    gzipSync(`rowdy://exec/${sandbox}/${day}/${version}/${vm}/${exec}`).toString('base64url'),

  /** The command an id locates, refused unless it's one of `sandbox`'s. The id comes from the caller. */
  parse: (cmdId: string, sandbox: string): CmdLocator => {
    let url = '';
    try {
      // A short URL, so anything that inflates past this isn't one.
      url = gunzipSync(Buffer.from(cmdId, 'base64url'), { maxOutputLength: 1024 }).toString();
    } catch {
      url = '';
    }
    const [, found, day, version, vm, exec] = CMD_URL.exec(url) ?? [];
    if (found !== sandbox || !day || !version || !vm || !exec) {
      throw new SandboxError('Not a command in this sandbox.');
    }
    return { sandbox, day, version, vm, exec };
  },
};

/** The most one read of a command's output answers with, in bytes. */
export const EXEC_OUTPUT = { limit: 64 * 1024 };

type ExecLine = { timestamp: number; seq: number; stream: number; data: string; dropped?: boolean };

/**
 * Part of a command's output, from the log stream `logStreamNamePrefix` names in `logGroup`, the sandbox's own. History
 * can come back short while frames are still reaching CloudWatch, and `timeout` tails for them: frames are answered in
 * `seq` order, so one seen by both counts once, and a read stops at a gap.
 */
export const execOutput = (
  logGroup: string,
  { logStreamNamePrefix, exec }: { logStreamNamePrefix: string; exec: string },
  { cursor, stream, timeout, signal }: ExecOutputOptions = {},
  credentials?: AwsSandboxOptions['credentials']
): Observable<ExecOutput> =>
  defer(() => {
    const filterPattern = `"${EXEC_LOG.key}" "${exec}"`;

    const [startTime = 0, start = 0] = cursor?.split('.').map(Number) ?? [];
    if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(start)) {
      throw new SandboxError('Not a cursor from this command.');
    }

    const logs = new CloudWatchLogsClient({ region: logGroup.split(':')[3], credentials });
    const abort = new AbortController();

    // Pages can be empty before the events arrive, so only a missing token ends this.
    const history$ = from(
      paginateFilterLogEvents(
        { client: logs },
        { logGroupIdentifier: logGroup, logStreamNamePrefix, filterPattern, startTime }
      )
    ).pipe(concatMap(({ events = [] }) => events));

    const session$ = defer(() =>
      logs.send(
        new StartLiveTailCommand({
          logGroupIdentifiers: [logGroup],
          logStreamNamePrefixes: [logStreamNamePrefix],
          logEventFilterPattern: filterPattern,
        }),
        { abortSignal: abort.signal }
      )
    ).pipe(
      switchMap(({ responseStream }) => responseStream ?? EMPTY),
      share()
    );

    // Tail first: a frame landing between the two would otherwise be missed by both.
    const tailed$ = session$.pipe(
      filter(({ sessionStart }) => !!sessionStart),
      take(1),
      switchMap(() => history$),
      share()
    );

    const events$ =
      timeout === undefined
        ? history$
        : merge(tailed$, session$.pipe(concatMap(({ sessionUpdate }) => sessionUpdate?.sessionResults ?? []))).pipe(
            // The wait is for what's still to come, so it starts once history is read.
            takeUntil(tailed$.pipe(ignoreElements(), endWith(undefined), delay(timeout)))
          );

    let bytes = 0;

    const line$ = events$.pipe(
      takeUntil(signal ? fromEvent(signal, 'abort') : NEVER),
      // What's in a log isn't all rowdy's: a line that isn't a frame is skipped.
      concatMap(({ message = '', timestamp = 0 }) => {
        try {
          const line: Omit<ExecLine, 'timestamp'> | undefined = JSON.parse(message)[EXEC_LOG.key];
          return line ? [{ ...line, timestamp }] : [];
        } catch {
          return [];
        }
      }),
      scan(
        ({ waiting, next }, line) => {
          if (line.seq >= next) waiting.set(line.seq, line);
          const ready: ExecLine[] = [];
          for (let found = waiting.get(next); found; found = waiting.get(next)) {
            ready.push(found);
            waiting.delete(next);
            next += 1;
          }
          return { waiting, next, ready };
        },
        { waiting: new Map<number, ExecLine>(), next: start, ready: [] as ExecLine[] }
      ),
      concatMap(({ ready }) => ready)
    );

    return line$.pipe(
      map((line) => {
        const output = line.stream === EXEC_STREAM.STDOUT || line.stream === EXEC_STREAM.STDERR;
        const wanted = !stream || line.stream === EXEC_STREAM[stream === 'stdout' ? 'STDOUT' : 'STDERR'];
        return { ...line, payload: Buffer.from(line.data, 'base64'), kept: output && wanted };
      }),
      takeWhile(({ payload, kept }) => (bytes += kept ? payload.length : 0) <= EXEC_OUTPUT.limit),
      takeWhile((line) => line.stream !== EXEC_STREAM.EXIT, true),
      reduce(
        (read, { timestamp, seq, stream: from, payload, kept, dropped }) => {
          if (kept) read.chunks.push(payload);
          read.dropped ||= !!dropped;
          // The cursor stays on an exit, so reading on from the end still says how it ended.
          if (from === EXEC_STREAM.EXIT) read.exitCode = (JSON.parse(payload.toString()) as ShellExit).code;
          else read.cursor = `${timestamp}.${seq + 1}`;
          return read;
        },
        {
          chunks: [] as Buffer[],
          cursor: cursor ?? '0.0',
          exitCode: undefined as number | undefined,
          dropped: false,
        }
      ),
      map(({ chunks, ...read }) => ({ ...read, text: Buffer.concat(chunks).toString() })),
      finalize(() => {
        abort.abort();
        logs.destroy();
      })
    );
  });
