import { SeverityNumber, type Attributes, type Context, type LoggerProvider } from '@opentelemetry/api';
import { isLoggable, Logger, type ILoggable, type Loggable } from '../../log';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../otel/version';
import type { Tracker } from './tracker';

/** Where a traced call's lines go: a Logger, or OpenTelemetry log records. */
export type TraceSink = Pick<Logger, 'trace'>;

/** Each line as an OpenTelemetry log record at TRACE, in `context`, when its logger is enabled for one. */
export const recordsIn = (loggerProvider: LoggerProvider, context: Context): TraceSink => {
  const logger = loggerProvider.getLogger(PACKAGE_NAME, PACKAGE_VERSION);
  return {
    trace: (message, params = {}): void => {
      if (!logger.enabled({ severityNumber: SeverityNumber.TRACE, context })) return;
      const fields: Record<string, Loggable> = isLoggable(params) ? { value: params } : params;
      const attributes: Attributes = {};
      for (const [key, value] of Object.entries(fields)) {
        const primitive = Logger.asPrimitive(value);
        attributes[key] = primitive instanceof Error ? `${primitive.name}: ${primitive.message}` : primitive;
      }
      logger.emit({ severityNumber: SeverityNumber.TRACE, severityText: 'TRACE', body: message, attributes, context });
    },
  };
};

const ms = (since: number, until = performance.now()): string => `${(until - since).toFixed(2)} ms`;

/** A value as logged: itself when Loggable, otherwise only its class name, never its contents. */
const loggable = (value: unknown): Loggable =>
  isLoggable(value)
    ? value
    : ({ repr: (): string => (value as object)?.constructor?.name || typeof value } satisfies ILoggable);

export const logCall = (logger: TraceSink, method: string, args: unknown[]): void =>
  logger.trace(`${method} Called`, args.length ? { args: args.map(loggable) as Loggable } : {});

/** Logs how a run went, with the time since it started, or since its subscription did. */
export const logRun = (logger: TraceSink, method: string): Tracker => {
  let started = performance.now();
  let emissions: number | undefined;
  const counted = (): { emissions?: number } => (emissions === undefined ? {} : { emissions });

  return {
    subscribe: (): void => {
      started = performance.now();
      emissions = 0;
    },
    emit: (emission): void => {
      emissions = (emissions ?? 0) + 1;
      logger.trace(`${method} Emitted`, { duration: ms(started), value: loggable(emission) });
    },
    complete: (...value): void =>
      logger.trace(`${method} Completed`, {
        duration: ms(started),
        ...counted(),
        ...(value.length ? { value: loggable(value[0]) } : {}),
      }),
    fail: (error): void =>
      logger.trace(`${method} Failed`, {
        duration: ms(started),
        ...counted(),
        error: error instanceof Error ? error : String(error),
      }),
    unsubscribe: (): void => logger.trace(`${method} Unsubscribed`, { duration: ms(started), ...counted() }),
    returned: (at): void => logger.trace(`${method} Returned`, { duration: ms(started, at) }),
  };
};
