import { context as otel } from '@opentelemetry/api';
import { finalize, isObservable, Observable, tap } from 'rxjs';
import { isLoggable, log, type ILoggable, type Loggable, type Logger } from '../../log';
import { logCall, logSubscription } from './logging';
import { startSpan } from './span';
import type { Tracker } from './tracker';

/**
 * Traces a method that returns an Observable.
 *
 * Each subscription is a span named for the method, a child of the span active at subscribe and
 * the parent of spans made while subscribing. It ends with `rowdy.observable.outcome` (`complete`,
 * `error` or `unsubscribe`) and `rowdy.observable.emissions`; an error is also recorded on it, with
 * an error status. Spans are made at any log level; without a tracer provider they are no-ops.
 *
 * At trace level it also logs, on `logger`, one line when it is called (with its arguments), then
 * one per emission, and one when the subscription ends, with the time since it was subscribed:
 *
 *     TRACE RequestId: … Lambda LambdaResponse.into Called
 *     TRACE RequestId: … Lambda LambdaResponse.into Emitted Duration: 2.12 ms Value: Result(…)
 *     TRACE RequestId: … Lambda LambdaResponse.into Completed Duration: 2.15 ms Emissions: 1
 *
 * A subscription that ends with an error logs `Failed` with the error; one that is unsubscribed
 * first (the loser of a `race`, an aborted request) logs `Unsubscribed`.
 */
export function Trace<This, Args extends ILoggable[], T extends Loggable>(
  logger: Logger = log
): (
  value: (this: This, ...args: Args) => Observable<T>,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Observable<T>>
) => (this: This, ...args: Args) => Observable<T> {
  return (value, context) => {
    const name = String(context.name);

    return function (this: This, ...args: Args): Observable<T> {
      const logging = logger.isTracing;

      if (logging) {
        for (const a of args) {
          if (!isLoggable(a)) {
            throw new TypeError(`@Trace ${name}: argument is not Loggable`);
          }
        }
      }

      // The decorator output aliases a class that references itself statically as `_Name`.
      const owner = (this as { constructor?: { name?: string } } | undefined)?.constructor?.name?.replace(/^_+/, '');
      const method = owner ? `${owner}.${name}` : name;

      if (logging) {
        logCall(logger, method, args);
      }

      const result: unknown = value.apply(this, args);
      if (!isObservable(result)) {
        if (logging) {
          throw new TypeError(`@Trace ${name}: expected Observable<Loggable>`);
        }
        return result as Observable<T>;
      }

      return new Observable<T>((subscriber) => {
        const span = startSpan<T>(method, otel.active());
        // Logging first: a non-Loggable emission throws before the span counts it.
        const trackers: Tracker<T>[] = logging
          ? [logSubscription<T>(logger, method, name), span.tracker]
          : [span.tracker];
        let settled = false;
        const fail = (error: unknown): void => {
          settled = true;
          trackers.forEach((t) => t.error(error));
        };

        return otel.with(span.context, () =>
          (result as Observable<T>)
            .pipe(
              // Before the outcome reaches the subscriber, so the span has ended when it does.
              tap({
                next: (emission: T): void => {
                  try {
                    trackers.forEach((t) => t.next(emission));
                  } catch (error) {
                    // rxjs sends a throw from `next` downstream without calling this tap's `error`.
                    fail(error);
                    throw error;
                  }
                },
                error: fail,
                complete: (): void => {
                  settled = true;
                  trackers.forEach((t) => t.complete());
                },
              }),
              finalize((): void => {
                if (!settled) trackers.forEach((t) => t.unsubscribe());
              })
            )
            .subscribe(subscriber)
        );
      });
    };
  };
}
