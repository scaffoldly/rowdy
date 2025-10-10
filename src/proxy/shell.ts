import { EMPTY, from, map, Observable, of, Subject, switchMap } from 'rxjs';
import { FileDescriptors, Pipeline, Proxy, Request, Response } from '../pipeline';
import { PassThrough, Writable } from 'stream';
import { ILoggable, log, Logger, Trace } from '../log';
import { execa, Options } from 'execa';

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

  @Trace
  override invoke(): Observable<ShellResponse> {
    const { bin, args = [] } = this;
    if (!bin) {
      return EMPTY;
    }

    const options: Options = {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: this.pipeline.env,
      signal: this.signal,
      detached: this._background,
    };

    let response = new ShellResponse(bin, this._request.fds);

    return of(execa(bin, args, options)).pipe(
      switchMap((proc) => {
        proc.stdout?.pipe(this.request.stdout);
        proc.stderr?.pipe(this.request.stderr);
        this.request.stdin.pipe(proc.stdin!);

        if (this._background) {
          proc.on('error', (error) => {
            log.error(`${bin} error`, { bin, error });
            response.error(error);
          });
          proc.on('exit', (code) => {
            log.debug(`${bin} exited`, { bin, code });
            response.next({ code: code ?? 0 });
            response.complete();
          });
          proc.unref();
        }

        return from(proc);
      }),
      map((result) => {
        if (typeof result === 'string' || result instanceof Uint8Array) {
          log.error(`Unexpected result type: ${result}`);
          response.next({ code: -1 });
          response.complete();
          return response;
        }

        if (this._background) {
          // Already handled in the proc.on('exit') handler above
          return response;
        }

        response.next({ code: result.exitCode });
        response.complete();
        return response;
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

export class ShellResponse extends Subject<{ code: number }> implements ILoggable {
  static onData =
    (response: ShellResponse, stream: Writable) =>
    (chunk: Buffer): void => {
      response._bytes += chunk.length;
      stream.write(`[${response.bin}] ${chunk.toString()}`);
    };

  public readonly output = new PassThrough();
  private _bytes: number = 0;
  private _code?: number;

  constructor(
    public readonly bin: string,
    public readonly fds: FileDescriptors
  ) {
    super();
    this.subscribe(({ code }) => (this._code = code));

    this.fds.stdout.pipe(this.output, { end: false });
    this.fds.stderr.pipe(this.output, { end: false });

    const stdout = ShellResponse.onData(this, process.stdout);
    const stderr = ShellResponse.onData(this, process.stderr);

    this.fds.stdout.on('data', stdout);
    this.fds.stderr.on('data', stderr);

    this.output.on('data', (chunk: Buffer) => {
      this._bytes += chunk.length;
    });

    this.fds.stdout.on('end', () => {
      this.fds.stdout.removeListener('data', stdout);
      if (this.fds.stderr.readableEnded) {
        this.output.end();
      }
    });

    this.fds.stderr.on('end', () => {
      this.fds.stderr.removeListener('data', stderr);
      if (this.fds.stdout.readableEnded) {
        this.output.end();
      }
    });
  }

  repr(): string {
    return `ShellResponse(bin=${this.bin} code=${Logger.asPrimitive(this._code)}, bytes=${Logger.asPrimitive(this._bytes)})`;
  }
}
