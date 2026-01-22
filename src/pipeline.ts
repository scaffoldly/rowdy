import { defer, Observable, ReplaySubject } from 'rxjs';
import { ILoggable, Logger } from './log';
import { Environment } from './environment';
import { Routes } from './routes';
import { PassThrough, Readable, Writable } from 'stream';
import { CRI, GrpcRouter } from '@scaffoldly/rowdy-grpc';

export abstract class Pipeline implements ILoggable {
  private _createdAt = performance.now();
  private _router?: ReplaySubject<GrpcRouter>;

  constructor(public readonly environment: Environment) {}

  get log(): Logger {
    return this.environment.log;
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

  get router(): Observable<GrpcRouter> {
    let router = this._router;
    if (!router) {
      router = new ReplaySubject<GrpcRouter>(1);
    }
    return defer(() => router.asObservable());
  }

  withRouter(router: GrpcRouter): this {
    if (!this._router) {
      this._router = new ReplaySubject<GrpcRouter>(1);
      this._router.next(router);
    }
    return this;
  }

  abstract get name(): string;
  abstract into(): Observable<Request<Pipeline>>;
  abstract version(): Observable<CRI.VersionResponse>;
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
  private _deadline?: Date;

  constructor(protected readonly pipeline: P) {}

  public withDeadline(at: Date): this {
    this._deadline = at;
    return this;
  }

  public onDeadline(callback?: () => void): { cancel: (callback?: () => void) => void } {
    if (!this._deadline) {
      return { cancel: () => {} };
    }

    const delay = this._deadline.getTime() - Date.now();

    if (delay <= 0) {
      callback?.();
      return { cancel: () => {} };
    }

    const timeoutId = setTimeout(() => {
      callback?.();
    }, delay);

    return {
      cancel: (cb?: () => void) => {
        clearTimeout(timeoutId);
        cb?.();
      },
    };
  }

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
