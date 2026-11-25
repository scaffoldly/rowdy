import { SpanKind, SpanStatusCode, trace, type Attributes, type Context } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import type { ResolvedOptions } from '../../otel';
import { wiretap } from './logging';
import type { Tracker } from './tracker';

type Outcome = 'complete' | 'error' | 'unsubscribe' | 'returned';

/**
 * Starts a span for one run, as a child of `parent`, from the options' `tracerProvider`. The returned
 * context makes the span the parent of spans made during the run; the tracker ends it with the
 * outcome, and for an Observable the emission count. Each is also a log record: `Span Started` and
 * `Span Ended` at DEBUG, or `Span Ended` at WARN when it failed, with its ids when it is recorded.
 */
export const startSpan = (
  method: string,
  { tracerProvider, name, version, ...rest }: ResolvedOptions,
  parent: Context
): { context: Context; tracker: Tracker } => {
  const attributes = { 'code.function.name': method };
  const span = tracerProvider
    .getTracer(name, version)
    .startSpan(method, { kind: SpanKind.INTERNAL, attributes }, parent);
  const context = trace.setSpan(parent, span);
  const tap = wiretap({ tracerProvider, name, version, ...rest }, context);
  const started = performance.now();
  let emissions: number | undefined;

  // Read at the start: a span records nothing once ended, and one that never records has its parent's ids.
  const ids = ((): Attributes => {
    if (!span.isRecording()) return {};
    const { traceId, spanId } = span.spanContext();
    const parentId = trace.getSpanContext(parent)?.spanId;
    return { traceId, spanId, ...(parentId ? { parentId } : {}) };
  })();
  tap(SeverityNumber.DEBUG, 'Span Started', { name: method, ...ids, ...attributes });

  const end = (outcome: Outcome, at?: number, error?: unknown): void => {
    span.setAttribute('cdk.trace.outcome', outcome);
    if (emissions !== undefined) span.setAttribute('cdk.observable.emissions', emissions);
    span.end(at);
    tap(outcome === 'error' ? SeverityNumber.WARN : SeverityNumber.DEBUG, 'Span Ended', {
      name: method,
      duration: `${((at ?? performance.now()) - started).toFixed(2)} ms`,
      outcome,
      ...ids,
      ...(emissions === undefined ? {} : { emissions }),
      ...(error === undefined
        ? {}
        : { exception: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
    });
  };

  return {
    context,
    tracker: {
      subscribe: (): void => {
        emissions = 0;
      },
      emit: (): void => {
        emissions = (emissions ?? 0) + 1;
      },
      complete: (): void => end('complete'),
      fail: (error): void => {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.setAttribute('error.type', error instanceof Error ? error.name : typeof error);
        end('error', undefined, error);
      },
      unsubscribe: (): void => end('unsubscribe'),
      // A performance.now() reading, which OpenTelemetry takes as such.
      returned: (at): void => end('returned', at),
    },
  };
};
