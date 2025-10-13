import { Observable, ReplaySubject } from 'rxjs';
import { ILoggable } from './log';
import { Environment } from './environment';
import { Routes } from './routes';
import { PassThrough, Readable, Writable } from 'stream';

export abstract class Pipeline implements ILoggable {
  private _createdAt = performance.now();

  constructor(protected readonly environment: Environment) {}

  get env(): Record<string, string | undefined> {
    return this.environment.env;
  }

  get signal(): AbortSignal {
    return this.environment.signal;
  }

  get routes(): Routes {
    return this.environment.routes;
  }

  get createdAt(): number {
    return this._createdAt;
  }

  abstract into(): Observable<Request<Pipeline>>;
  abstract repr(): string;
}

export class FileDescriptors {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();

  end(): void {
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
  }
}

export abstract class Request<P extends Pipeline> implements ILoggable {
  public readonly createdAt = performance.now();
  public readonly fds = new FileDescriptors();

  constructor(protected readonly pipeline: P) {}

  get signal(): AbortSignal {
    return this.pipeline.signal;
  }

  get stdin(): Readable {
    return this.fds.stdin;
  }

  get stdout(): Writable {
    return this.fds.stdout;
  }

  get stderr(): Writable {
    return this.fds.stderr;
  }

  withInput(input: Readable): this {
    input.pipe(this.fds.stdin);
    return this;
  }

  abstract into(): Observable<Proxy<P, unknown>>;
  abstract repr(): string;
}

export abstract class Proxy<P extends Pipeline, T> implements ILoggable {
  constructor(
    public readonly pipeline: P,
    public readonly request: Request<P>
  ) {}

  get signal(): AbortSignal {
    return this.pipeline.signal;
  }

  abstract invoke(): Observable<T>;
  abstract into(): Observable<Response<P>>;
  abstract repr(): string;
}

export class Chunk {
  constructor(
    public readonly data: Buffer | string,
    public readonly bytes: number
  ) {}
}

export abstract class Response<P extends Pipeline> extends ReplaySubject<Chunk> implements ILoggable {
  constructor(
    protected readonly pipeline: P,
    public readonly request: Request<P>
  ) {
    super();
  }

  get signal(): AbortSignal {
    return this.pipeline.signal;
  }

  abstract into(): Observable<Result<P>>;
  abstract repr(): string;
}

export class Result<P extends Pipeline> implements ILoggable {
  public readonly createdAt = performance.now();

  constructor(
    protected readonly pipeline: P,
    public readonly request: Request<P>,
    public readonly success: boolean,
    public readonly bytes: number
  ) {}

  get uptime(): number {
    return performance.now() - this.pipeline.createdAt;
  }

  get duration(): number {
    return performance.now() - this.request.createdAt;
  }

  repr(): string {
    return `Result(success=${this.success}, bytes=${this.bytes}, duration=${this.duration.toFixed(2)}ms, uptime=${this.uptime.toFixed(2)}ms)`;
  }
}
