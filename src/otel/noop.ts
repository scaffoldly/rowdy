import {
  context,
  createNoopMeter,
  INVALID_SPAN_CONTEXT,
  trace,
  type MeterProvider,
  type Span,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';

/** Spans that record nothing, carrying their parent's context on, so spans under them still nest. */
const tracer: Tracer = {
  startSpan: (_name, _options, parent = context.active()): Span =>
    trace.wrapSpanContext(trace.getSpanContext(parent) ?? INVALID_SPAN_CONTEXT),
  startActiveSpan: ((name: string, ...rest: unknown[]) => {
    const fn = rest[rest.length - 1] as (span: Span) => unknown;
    const span = tracer.startSpan(name);
    return context.with(trace.setSpan(context.active(), span), fn, undefined, span);
  }) as Tracer['startActiveSpan'],
};

export const NOOP_TRACER_PROVIDER: TracerProvider = { getTracer: () => tracer };

const meter = createNoopMeter();

export const NOOP_METER_PROVIDER: MeterProvider = { getMeter: () => meter };
