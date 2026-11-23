import { SpanKind, SpanStatusCode, trace, type Context } from '@opentelemetry/api';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../otel/version';
import type { Tracker } from './tracker';

type Outcome = 'complete' | 'error' | 'unsubscribe';

/**
 * Starts a span for one subscription, as a child of `parent`. The returned context makes it the
 * parent of spans made while subscribing; the tracker ends it with the outcome and emission count.
 */
export const startSpan = <T>(method: string, parent: Context): { context: Context; tracker: Tracker<T> } => {
  // Per subscription: a tracer taken before a provider is registered stays a no-op.
  const span = trace
    .getTracer(PACKAGE_NAME, PACKAGE_VERSION)
    .startSpan(method, { kind: SpanKind.INTERNAL, attributes: { 'code.function.name': method } }, parent);
  let emissions = 0;

  const end = (outcome: Outcome): void => {
    span.setAttributes({ 'rowdy.observable.outcome': outcome, 'rowdy.observable.emissions': emissions });
    span.end();
  };

  return {
    context: trace.setSpan(parent, span),
    tracker: {
      next: (): void => {
        emissions += 1;
      },
      error: (error: unknown): void => {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.setAttribute('error.type', error instanceof Error ? error.name : typeof error);
        end('error');
      },
      complete: (): void => end('complete'),
      unsubscribe: (): void => end('unsubscribe'),
    },
  };
};
