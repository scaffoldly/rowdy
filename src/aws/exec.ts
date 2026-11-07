import {
  concatMap,
  defer,
  endWith,
  ignoreElements,
  lastValueFrom,
  map,
  Observable,
  OperatorFunction,
  ReplaySubject,
  tap,
} from 'rxjs';
import { Exec, ExecFinished, ExecFrame } from '../api/types';
import { EXEC_STREAM, ShellExit } from '../proxy/shell';

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
export const execOf = (cmdId: string, source: Observable<ExecFrame>): Observable<Exec> =>
  new Observable<Exec>((subscriber) => {
    // Only a subscriber that's late to a running command needs these.
    const frames = new ReplaySubject<ExecFrame>(32);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let exit: ShellExit | undefined;

    const exec: Exec = {
      cmdId,
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
