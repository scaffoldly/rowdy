import { context as otel, type Context } from '@opentelemetry/api';
import type { CdkOptions } from '../../cdk';
import { logRun, recordsIn, type TraceSink } from './logging';
import { measureRun } from './metrics';
import { startSpan } from './span';
import { all, type Tracker } from './tracker';

/** One run of a traced method: its span's context, where its lines go, and what follows it. */
export interface Run {
  readonly context: Context;
  readonly sinks: TraceSink[];
  readonly tracker: Tracker;
}

/** A call to a traced method, and how to start another run of it, e.g. for a resubscription. */
export interface Call {
  /** The context active at the call; its run is a child of it. */
  readonly parent: Context;
  readonly run: Run;
  again(): Run;
}

/** Starts a run under `parent`: its span, its lines as log records, and its duration. */
export const startRun = (method: string, options: Required<CdkOptions>, parent: Context = otel.active()): Run => {
  const span = startSpan(method, options, parent);
  const sinks = [recordsIn(options.loggerProvider, span.context)];
  const trackers = [...sinks.map((sink) => logRun(sink, method)), span.tracker, measureRun(method, options)];
  return { context: span.context, sinks, tracker: all(trackers) };
};
