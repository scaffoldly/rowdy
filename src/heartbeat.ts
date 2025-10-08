import { delay, EMPTY, Observable, of } from 'rxjs';
import { ILoggable, Trace } from './log';
import { Pipeline, Result, Request, Response, Proxy } from './pipeline';

export class HeartbeatPipeline extends Pipeline implements ILoggable {
  private delay = 5000;

  every(delayMs: number): Observable<Request<Pipeline>> {
    this.delay = delayMs;
    return this.into();
  }

  @Trace
  override into(): Observable<Request<Pipeline>> {
    const result = new Result(this, true, 0);

    const response = new (class extends Response<Pipeline> implements ILoggable {
      override into(): Observable<Result<Pipeline>> {
        return of(result);
      }
      override repr(): string {
        return `HeartbeatResponse()`;
      }
    })(this);

    const proxy = new (class extends Proxy<Pipeline, unknown> implements ILoggable {
      override invoke(): Observable<unknown> {
        return EMPTY;
      }
      override into(): Observable<Response<Pipeline>> {
        return of(response);
      }
      override repr(): string {
        return `HeartbeatProxy()`;
      }
    })(this);

    const request = new (class extends Request<Pipeline> implements ILoggable {
      override into(): Observable<Proxy<Pipeline, unknown>> {
        return of(proxy);
      }
      override repr(): string {
        return `HeartbeatRequest()`;
      }
    })(this);

    return of(request).pipe(delay(this.delay));
  }

  override repr(): string {
    return `HeartbeatPipeline()`;
  }
}
