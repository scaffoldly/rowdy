import { context as otel, trace, type Attributes, type Span } from '@opentelemetry/api';
import {
  defer,
  filter,
  finalize,
  Observable,
  repeat,
  retry,
  take,
  takeUntil,
  tap,
  timer,
  type MonoTypeOperatorFunction,
  type ObservableInput,
} from 'rxjs';
import { CdkInstrumentation } from '../../otel';
import { logCall } from './logging';
import { startRun } from './run';

type Ending = 'complete' | 'error' | 'unsubscribe';

/** Set on each run's span as it starts. Ids go here, not in the name, which stays low-cardinality. */
export type TracedOptions = { attributes?: Attributes };

/**
 * Each subscription to what `make` builds is a run of `name`, like a traced method's: a span, its
 * duration and its lines, through the one CdkInstrumentation. `make` gets the span, and its
 * `attributes` are set on it as the run ends.
 */
export const traced = <T>(
  name: string,
  { attributes: given, args }: TracedOptions & { args?: unknown[] },
  make: (span: Span | undefined) => { source: Observable<T>; attributes: (ending: Ending) => Attributes }
): Observable<T> =>
  new Observable<T>((subscriber) => {
    const run = startRun(name, CdkInstrumentation.create().options, otel.active());
    if (args) run.sinks.forEach((sink) => logCall(sink, name, args));
    const span = trace.getSpan(run.context);
    if (given) span?.setAttributes(given);
    const { source, attributes } = make(span);
    run.tracker.subscribe();
    let settled = false;
    const ending = (how: Ending): void => {
      settled = true;
      span?.setAttributes(attributes(how));
    };

    return otel.with(run.context, () =>
      source
        .pipe(
          tap({
            next: (value) => run.tracker.emit(value),
            error: (error: unknown) => {
              ending('error');
              run.tracker.fail(error);
            },
            complete: () => {
              ending('complete');
              run.tracker.complete();
            },
          }),
          finalize(() => {
            if (settled) return;
            ending('unsubscribe');
            run.tracker.unsubscribe();
          })
        )
        .subscribe(subscriber)
    );
  });

/**
 * Subscribes to the source again every `delay` ms until a value matches `until`, and emits that one,
 * in place of `repeat({ delay })` + `first(until)`. With a `timeout`, completes without a value once
 * that many ms have passed. Each wait is a span named `name`, the parent of what each poll does,
 * with `cdk.poll.attempts` and `cdk.poll.outcome`: `satisfied`, `timeout`, `error` or `unsubscribe`.
 */
export const poll =
  <T>(
    name: string,
    until: (value: T) => boolean,
    { delay, timeout, ...options }: TracedOptions & { delay: number; timeout?: number }
  ): MonoTypeOperatorFunction<T> =>
  (source) =>
    traced(name, options, () => {
      let attempts = 0;
      let satisfied = false;
      const repeated = defer(() => {
        attempts += 1;
        return source;
      }).pipe(repeat({ delay }));
      const polled = (timeout === undefined ? repeated : repeated.pipe(takeUntil(timer(timeout)))).pipe(
        filter(until),
        take(1),
        tap(() => (satisfied = true))
      );
      return {
        source: polled,
        attributes: (ending) => ({
          'cdk.poll.attempts': attempts,
          'cdk.poll.outcome': ending === 'complete' ? (satisfied ? 'satisfied' : 'timeout') : ending,
        }),
      };
    });

/**
 * `retry({ count, delay, resetOnSuccess })`, its delay the same: called with each error and the retry count, it
 * returns what to wait for before retrying, or throws to stop. Each run is a span named `name`, with
 * `cdk.retry.attempts`, and an `exception` event, with `cdk.retry.attempt`, for each failure retried.
 */
export const retrying =
  <T>(
    name: string,
    delay: (error: unknown, retryCount: number) => ObservableInput<unknown>,
    { count, resetOnSuccess, ...options }: TracedOptions & { count?: number; resetOnSuccess?: boolean } = {}
  ): MonoTypeOperatorFunction<T> =>
  (source) =>
    traced(name, options, (span) => {
      let attempts = 0;
      const tried = defer(() => {
        attempts += 1;
        return source;
      }).pipe(
        retry({
          count,
          resetOnSuccess,
          delay: (error: unknown, retryCount: number) => {
            span?.addEvent('exception', {
              'exception.type': error instanceof Error ? error.name : typeof error,
              'exception.message': error instanceof Error ? error.message : String(error),
              'cdk.retry.attempt': retryCount,
            });
            return delay(error, retryCount);
          },
        })
      );
      return { source: tried, attributes: () => ({ 'cdk.retry.attempts': attempts }) };
    });
