import { context as otel, type Context, type TracerProvider } from '@opentelemetry/api';
import type { Logger } from '../../log';
import { logRun } from './logging';
import { startSpan } from './span';
import { all, type Tracker } from './tracker';

/** One run of a traced method: its span's context, and what follows it. */
export interface Run {
  readonly context: Context;
  readonly tracker: Tracker;
}

/** A call to a traced method, and how to start another run of it, e.g. for a resubscription. */
export interface Call {
  /** The context active at the call; its run is a child of it. */
  readonly parent: Context;
  readonly run: Run;
  again(): Run;
}

/** How a traced call is followed: `logger` only when it logs at trace level. */
export interface Tracing {
  logger?: Logger;
  tracerProvider?: TracerProvider;
}

/** Starts a run under `parent`, its span from the call's `tracerProvider` or else the global one. */
export const startRun = (method: string, { logger, tracerProvider }: Tracing, parent: Context = otel.active()): Run => {
  const span = startSpan(method, parent, tracerProvider);
  return {
    context: span.context,
    tracker: logger ? all([logRun(logger, method), span.tracker]) : span.tracker,
  };
};
