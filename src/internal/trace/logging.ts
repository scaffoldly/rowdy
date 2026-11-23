import { isLoggable, type ILoggable, type Loggable, type Logger } from '../../log';
import type { Tracker } from './tracker';

const ms = (since: number, until = performance.now()): string => `${(until - since).toFixed(2)} ms`;

/** A value as logged: itself when Loggable, otherwise only its class name, never its contents. */
const loggable = (value: unknown): Loggable =>
  isLoggable(value)
    ? value
    : ({ repr: (): string => (value as object)?.constructor?.name || typeof value } satisfies ILoggable);

export const logCall = (logger: Logger, method: string, args: unknown[]): void =>
  logger.trace(`${method} Called`, args.length ? { args: args.map(loggable) as Loggable } : {});

/** Logs how a run went, with the time since it started, or since its subscription did. */
export const logRun = (logger: Logger, method: string): Tracker => {
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
