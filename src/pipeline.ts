import { Observable, ReplaySubject } from 'rxjs';
import { ILoggable } from './log';
import { Environment } from './environment';
import { Routes } from './routes';

export abstract class Pipeline implements ILoggable {
  private _last?: Request<Pipeline>;

  constructor(protected readonly environment: Environment) {
    const subscription = this.into().subscribe((last) => (this._last = last));
    this.signal.addEventListener('abort', () => subscription.unsubscribe());
  }

  get signal(): AbortSignal {
    return this.environment.signal;
  }

  get routes(): Routes {
    return this.environment.routes;
  }

  get createdAt(): number {
    return this._last?.createdAt || performance.now();
  }

  abstract into(): Observable<Request<Pipeline>>;
  abstract repr(): string;
}

export abstract class Request<P extends Pipeline> implements ILoggable {
  public readonly createdAt = performance.now();

  constructor(protected readonly pipeline: P) {}

  get signal(): AbortSignal {
    return this.pipeline.signal;
  }

  abstract into(): Observable<Proxy<P, unknown>>;
  abstract repr(): string;
}

export abstract class Proxy<P extends Pipeline, T> implements ILoggable {
  constructor(protected readonly pipeline: P) {}

  get signal(): AbortSignal {
    return this.pipeline.signal;
  }

  abstract invoke(): Observable<T>;
  abstract into(): Observable<Response<P>>;
  abstract repr(): string;
}

export abstract class Response<P extends Pipeline> extends ReplaySubject<Buffer | string> implements ILoggable {
  constructor(protected readonly pipeline: P) {
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
    public readonly success: boolean,
    public readonly bytes: number
  ) {}

  get duration(): number {
    return this.createdAt - this.pipeline.createdAt;
  }

  repr(): string {
    return `Result(success=${this.success}, bytes=${this.bytes}, duration=${this.duration.toFixed(2)}ms)`;
  }
}
