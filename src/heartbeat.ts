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
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const pipeline = this;

    const request = new (class extends Request<Pipeline> implements ILoggable {
      override into(): Observable<Proxy<Pipeline, unknown>> {
        const proxy = new (class extends Proxy<Pipeline, unknown> implements ILoggable {
          override invoke(): Observable<unknown> {
            return EMPTY;
          }
          override into(): Observable<Response<Pipeline>> {
            return of(
              new (class extends Response<Pipeline> implements ILoggable {
                override into(): Observable<Result<Pipeline>> {
                  return of(new Result(pipeline, request, true, 0));
                }
                override repr(): string {
                  return `HeartbeatResponse()`;
                }
              })(pipeline, this.request)
            );
          }
          override repr(): string {
            return `HeartbeatProxy()`;
          }
        })(pipeline, request);
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
