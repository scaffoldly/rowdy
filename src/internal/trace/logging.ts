import { SeverityNumber, type Attributes, type Context } from '@opentelemetry/api';
import { isLoggable, Logger, maskJson, type ILoggable, type Loggable } from '../../log';
import type { ResolvedOptions } from '../../otel';
import { redactArgs, redactResult, type Redactor } from './redact';
import type { Tracker } from './tracker';

/** Where a traced call's lines go: a Logger, or OpenTelemetry log records. */
export type TraceSink = Pick<Logger, 'trace'>;

/** A log record at `severity`, in the run's context, when the options' logger is enabled for one. */
export type Wiretap = (severity: SeverityNumber, message: string, attributes?: Attributes) => void;

export const wiretap = ({ loggerProvider, name, version }: ResolvedOptions, context: Context): Wiretap => {
  const logger = loggerProvider.getLogger(name, version);
  return (severityNumber, body, attributes = {}) => {
    if (!(logger.enabled?.({ severityNumber, context }) ?? true)) return;
    logger.emit({ severityNumber, severityText: SeverityNumber[severityNumber], body, attributes, context });
  };
};

/** Each line as an OpenTelemetry log record at TRACE, in `context`. */
export const recordsIn = (options: ResolvedOptions, context: Context): TraceSink => {
  const tap = wiretap(options, context);
  return {
    trace: (message, params = {}): void => {
      const fields: Record<string, Loggable> = isLoggable(params) ? { value: params } : params;
      const attributes: Attributes = {};
      for (const [key, value] of Object.entries(fields)) {
        const primitive = Logger.asPrimitive(value);
        attributes[key] = primitive instanceof Error ? `${primitive.name}: ${primitive.message}` : primitive;
      }
      tap(SeverityNumber.TRACE, message, attributes);
    },
  };
};

const ms = (since: number, until = performance.now()): string => `${(until - since).toFixed(2)} ms`;

const MAX = 1024;

/**
 * A value as logged: itself when Loggable; a plain object or array as masked JSON, capped at
 * MAX characters; anything else only its class name, never its contents.
 */
const loggable = (value: unknown): Loggable => {
  if (isLoggable(value)) return value;
  const proto = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (Array.isArray(value) || proto === Object.prototype || proto === null) {
    const json = maskJson(value);
    return json.length > MAX ? `${json.slice(0, MAX)}… (${json.length} chars)` : json;
  }
  return { repr: (): string => (value as object)?.constructor?.name || typeof value } satisfies ILoggable;
};

export const logCall = (logger: TraceSink, method: string, args: unknown[], redactor?: Redactor): void => {
  const logged = redactArgs(redactor, args);
  logger.trace(`${method} Called`, logged.length ? { args: logged.map(loggable) as Loggable } : {});
};

/** Logs how a run went, with the time since it started, or since its subscription did. */
export const logRun = (logger: TraceSink, method: string, redactor?: Redactor): Tracker => {
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
      logger.trace(`${method} Emitted`, { duration: ms(started), value: loggable(redactResult(redactor, emission)) });
    },
    complete: (...value): void =>
      logger.trace(`${method} Completed`, {
        duration: ms(started),
        ...counted(),
        ...(value.length ? { value: loggable(redactResult(redactor, value[0])) } : {}),
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
