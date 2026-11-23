import { SpanKind, SpanStatusCode, trace, type Context } from '@opentelemetry/api';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../otel/version';
import type { Tracker } from './tracker';

type Outcome = 'complete' | 'error' | 'unsubscribe' | 'returned';

/**
 * Starts a span for one run, as a child of `parent`. The returned context makes it the parent of
 * spans made during the run; the tracker ends it with the outcome, and for an Observable the
 * emission count.
 */
export const startSpan = (method: string, parent: Context): { context: Context; tracker: Tracker } => {
  // Per run: a tracer taken before a provider is registered stays a no-op.
  const span = trace
    .getTracer(PACKAGE_NAME, PACKAGE_VERSION)
    .startSpan(method, { kind: SpanKind.INTERNAL, attributes: { 'code.function.name': method } }, parent);
  let emissions: number | undefined;

  const end = (outcome: Outcome, at?: number): void => {
    span.setAttribute('rowdy.trace.outcome', outcome);
    if (emissions !== undefined) span.setAttribute('rowdy.observable.emissions', emissions);
    span.end(at);
  };

  return {
    context: trace.setSpan(parent, span),
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
        end('error');
      },
      unsubscribe: (): void => end('unsubscribe'),
      // A performance.now() reading, which OpenTelemetry takes as such.
      returned: (at): void => end('returned', at),
    },
  };
};
