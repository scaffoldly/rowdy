import {
  catchError,
  EMPTY,
  filter,
  from,
  fromEvent,
  interval,
  map,
  Observable,
  of,
  race,
  startWith,
  Subject,
  switchMap,
  take,
  takeUntil,
  timer,
} from 'rxjs';
import { FileDescriptors, Pipeline, Proxy, Request, Response } from '../pipeline';
import { PassThrough } from 'stream';
import { ILoggable, log as root, Logger, Trace } from '../log';
import { execa } from 'execa';
import type { ExecaError, Options } from 'execa';
import { constants } from 'os';
import { readdir, readFile } from 'fs/promises';

const log = root.child('shell');

export class ShellRequest<P extends Pipeline> extends Request<P> {
  constructor(
    pipeline: P,
    public readonly command: string[]
  ) {
    super(pipeline);
  }

  override into(): Observable<Proxy<P, unknown>> {
    throw new Error('Method not implemented.');
  }

  override repr(): string {
    throw new Error('Method not implemented.');
  }
}

export class ShellProxy<P extends Pipeline> extends Proxy<P, ShellResponse> {
  private _background: boolean = false;
  private readonly bin: string | undefined;
  private readonly args: string[];
  private _request: ShellRequest<P>;

  constructor(pipeline: P, request: ShellRequest<P>) {
    super(pipeline, request);
    this.bin = request.command[0];
    this.args = request.command.slice(1);
    this._request = request;
  }

  background(): this {
    this._background = true;
    return this;
  }

  @Trace(log)
  override invoke(): Observable<ShellResponse> {
    const { bin, args = [] } = this;
    if (!bin) {
      return EMPTY;
    }

    return this.pipeline.environment.Env.pipe(
      take(1),
      switchMap((env) => {
        const options: Options = {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env,
          signal: this.signal,
          detached: this._background,
        };

        const response = new ShellResponse(bin, this._request.fds);

        log.debug(`Executing command`, { bin, args, background: this._background });

        return of(execa(bin, args, options)).pipe(
          switchMap((proc) => {
            log.debug(`${bin} started`, { bin, pid: proc.pid });
            proc.stdout?.pipe(this.request.stdout);
            proc.stderr?.pipe(this.request.stderr);
            this.request.stdin.pipe(proc.stdin!);

            if (this._background) {
              // DEVNOTE: The response is handed back while the command runs; its end is reported
              // through it once execa settles. A rejection (non-zero exit, signal, failed spawn) must
              // be handled here: unhandled, it is thrown on a later tick, which on Lambda is the next
              // invocation after a thaw.
              proc.then(
                ({ exitCode }) => {
                  log.debug(`${bin} exited`, { bin, code: exitCode });
                  response.settle({ code: exitCode });
                },
                (error: ExecaError) => {
                  const exit = exitOf(error);
                  log.debug(`${bin} exited`, { bin, code: exit.code, signal: exit.signal ?? '' });
                  response.settle(exit);
                }
              );
              proc.unref();
              if (proc.pid) {
                response.watch(proc.pid);
              }
              return of(response);
            }

            return from(proc);
          }),
          map((result) => {
            if (typeof result === 'string' || result instanceof Uint8Array) {
              log.error('Unexpected Command Result', { bin, type: typeof result });
              response.next({ code: -1 });
              response.complete();
              return response;
            }

            if (result instanceof ShellResponse) {
              return result;
            }

            response.next({ code: result.exitCode });
            response.complete();
            return response;
          })
        );
      })
    );
  }

  override into(): Observable<Response<P>> {
    throw new Error('Method not implemented.');
  }

  override repr(): string {
    throw new Error('Method not implemented.');
  }
}

/** How a command ended. `message` is execa's summary, e.g. `Command was killed with SIGSEGV (Segmentation fault): node server.js`. */
export type ShellExit = { code: number; signal?: NodeJS.Signals; message?: string };

const isSignal = (name: string): name is NodeJS.Signals => name in constants.signals;

// The exit a failed run stands for: a signal as 128 + its number, a command that never started (an
// `error` event, which is what sets `originalMessage`) as 127. execa types `exitCode` as a number but
// leaves it undefined in both of those cases, so it is checked rather than trusted.
const exitOf = (error: ExecaError): ShellExit => {
  const message = error.shortMessage;
  if (error.signal && isSignal(error.signal)) {
    const code = 128 + constants.signals[error.signal];
    log.debug('Exit From Signal', { signal: error.signal, code });
    return { code, signal: error.signal, message };
  }
  if (Number.isInteger(error.exitCode)) {
    log.debug('Exit From Exit Code', { code: error.exitCode });
    return { code: error.exitCode, message };
  }
  const started = error.originalMessage === undefined;
  log.debug(started ? 'Exit Without Code' : 'Exit Before Start', {
    signal: error.signal ?? '',
    originalMessage: error.originalMessage ?? '',
  });
  return { code: started ? 1 : 127, message };
};

/** The command's memory, threads and descriptors, as last read from /proc/<pid>. */
export type ProcessSample = {
  rssKb: number;
  hwmKb?: number;
  sizeKb?: number;
  threads: number;
  fds?: number;
  at: number;
};

/** What rowdy knew about the command when it exited: how long it ran, its last /proc sample, its last output. */
export type ExitContext = {
  uptimeMs: number;
  sample?: ProcessSample;
  recent: ReadonlyArray<string>;
};

const kb = (status: string, field: string): number | undefined => {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, 'm').exec(status);
  return match?.[1] ? Number(match[1]) : undefined;
};

/** VmRSS, VmHWM and VmSize (kB) and Threads from the text of /proc/<pid>/status; undefined without VmRSS or Threads. */
export const parseStatus = (status: string, at: number, fds?: number): ProcessSample | undefined => {
  const rssKb = kb(status, 'VmRSS');
  const threads = /^Threads:\s+(\d+)$/m.exec(status)?.[1];
  if (rssKb === undefined || !threads) {
    return undefined;
  }
  const hwmKb = kb(status, 'VmHWM');
  const sizeKb = kb(status, 'VmSize');
  return {
    rssKb,
    ...(hwmKb === undefined ? {} : { hwmKb }),
    ...(sizeKb === undefined ? {} : { sizeKb }),
    threads: Number(threads),
    ...(fds === undefined ? {} : { fds }),
    at,
  };
};

// How often a running command's /proc is read, and how many of its last output lines are kept.
const SAMPLE_MS = 2000;
const RECENT_LINES = 50;
// How long the end of a command waits for its output to be relayed, when something else (a process it
// started) still holds its stdout or stderr open.
const DRAIN_MS = 1000;

export class ShellResponse extends Subject<ShellExit> implements ILoggable {
  // The command's output, a line at a time, in the same shape as rowdy's own lines. Which stream
  // a line came from is the component; severity is not inferred from it.
  static onData = (response: ShellResponse, stream: 'stdout' | 'stderr'): ((chunk?: Buffer) => void) => {
    const out = root.child(stream);
    const sink = stream === 'stdout' ? 'info' : 'error';
    let partial = '';
    return (chunk?: Buffer): void => {
      if (!chunk) {
        out.relay(sink, partial); // stream ended: flush an unterminated last line
        if (partial) {
          response.keep(stream, partial);
        }
        partial = '';
        return;
      }
      response._bytes += chunk.length;
      const lines = (partial + chunk.toString()).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) {
        out.relay(sink, line);
        response.keep(stream, line);
      }
    };
  };

  public readonly output = new PassThrough();
  public readonly startedAt = performance.now();
  private _bytes: number = 0;
  private _code?: number;
  private _recent: string[] = [];
  private _sample?: ProcessSample;

  constructor(
    public readonly bin: string,
    public readonly fds: FileDescriptors
  ) {
    super();
    this.subscribe({ next: ({ code }) => (this._code = code), error: () => undefined });

    this.fds.stdout.pipe(this.output, { end: false });
    this.fds.stderr.pipe(this.output, { end: false });

    const stdout = ShellResponse.onData(this, 'stdout');
    const stderr = ShellResponse.onData(this, 'stderr');

    this.fds.stdout.on('data', stdout);
    this.fds.stderr.on('data', stderr);

    this.output.on('data', (chunk: Buffer) => {
      this._bytes += chunk.length;
    });

    this.fds.stdout.on('end', () => {
      stdout();
      this.fds.stdout.removeListener('data', stdout);
      if (this.fds.stderr.readableEnded) {
        this.output.end();
      }
    });

    this.fds.stderr.on('end', () => {
      stderr();
      this.fds.stderr.removeListener('data', stderr);
      if (this.fds.stdout.readableEnded) {
        this.output.end();
      }
    });
  }

  private keep(stream: 'stdout' | 'stderr', line: string): void {
    this._recent.push(`${stream}: ${line}`);
    if (this._recent.length > RECENT_LINES) {
      this._recent.shift();
    }
  }

  /**
   * Report the command's end once its output has been relayed: execa settles before the last chunks
   * have passed through to this response, which are the lines just before the exit.
   */
  settle(exit: ShellExit): void {
    race(fromEvent(this.output, 'end').pipe(take(1)), timer(DRAIN_MS))
      .pipe(take(1))
      .subscribe(() => {
        this.next(exit);
        this.complete();
      });
  }

  /** Read the command's /proc status until it exits; the last reading survives it. */
  watch(pid: number): void {
    interval(SAMPLE_MS)
      .pipe(
        startWith(0),
        takeUntil(this),
        switchMap(() =>
          from(
            Promise.all([
              readFile(`/proc/${pid}/status`, 'utf8'),
              readdir(`/proc/${pid}/fd`).then(
                (fds: string[]) => fds.length,
                (): undefined => undefined
              ),
            ])
          ).pipe(catchError(() => EMPTY))
        ),
        map(([status, fds]: [string, number | undefined]) => parseStatus(status, performance.now(), fds)),
        filter((sample: ProcessSample | undefined): sample is ProcessSample => sample !== undefined)
      )
      .subscribe((sample: ProcessSample) => (this._sample = sample));
  }

  context(): ExitContext {
    return {
      uptimeMs: performance.now() - this.startedAt,
      ...(this._sample ? { sample: this._sample } : {}),
      recent: [...this._recent],
    };
  }

  repr(): string {
    return `ShellResponse(bin=${this.bin} code=${Logger.asPrimitive(this._code)}, bytes=${Logger.asPrimitive(this._bytes)})`;
  }
}
