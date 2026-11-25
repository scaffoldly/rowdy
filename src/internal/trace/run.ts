import { context as otel, type Context } from '@opentelemetry/api';
import type { ResolvedOptions } from '../../otel';
import { logRun, recordsIn, type TraceSink } from './logging';
import { follow, type AttributeInput } from './attributes';
import type { Redactor } from './redact';
import { measureRun } from './metrics';
import { startSpan } from './span';
import { all, type Tracker } from './tracker';

/** One run of a traced method: its span's context, where its lines go, and what follows it. */
export interface Run {
  readonly context: Context;
  readonly sinks: TraceSink[];
  readonly tracker: Tracker;
  /** Sets attributes from @Attributes on the run's span, each as it is known, while the span is open. */
  annotate(values: Record<string, AttributeInput> | undefined): void;
}

/** A call to a traced method, and how to start another run of it, e.g. for a resubscription. */
export interface Call {
  /** The context active at the call; its run is a child of it. */
  readonly parent: Context;
  readonly run: Run;
  again(): Run;
  /** Calls the method's @Attributes hook for `run`, with what it returned: an Observable's, the run's emissions. */
  readonly annotate?: (run: Run, result: unknown) => void;
}

/** Starts a run under `parent`: its span, its lines as log records, and its duration. */
export const startRun = (
  method: string,
  options: ResolvedOptions,
  parent: Context = otel.active(),
  redactor?: Redactor
): Run => {
  const span = startSpan(method, options, parent);
  const sinks = [recordsIn(options, span.context)];
  const trackers = [
    ...sinks.map((sink) => logRun(sink, method, redactor)),
    span.tracker,
    measureRun(method, options, span.context),
  ];
  return {
    context: span.context,
    sinks,
    tracker: all(trackers),
    annotate: (values) => (values ? follow(span.annotated, values) : undefined),
  };
};
