import { isLoggable, type ILoggable, type Logger } from '../../log';
import type { Tracker } from './tracker';

const ms = (since: number): string => `${(performance.now() - since).toFixed(2)} ms`;

export const logCall = (logger: Logger, method: string, args: ILoggable[]): void =>
  logger.trace(`${method} Called`, args.length ? { args } : {});

/** Logs each emission and how the subscription ended, with the time since it was subscribed. */
export const logSubscription = <T>(logger: Logger, method: string, name: string): Tracker<T> => {
  const subscribed = performance.now();
  let emissions = 0;

  return {
    next: (emission: T): void => {
      if (!isLoggable(emission)) {
        throw new TypeError(`@Trace ${name}: emission is not Loggable`);
      }
      emissions += 1;
      logger.trace(`${method} Emitted`, { duration: ms(subscribed), value: emission });
    },
    error: (error: unknown): void =>
      logger.trace(`${method} Failed`, {
        duration: ms(subscribed),
        emissions,
        error: error instanceof Error ? error : String(error),
      }),
    complete: (): void => logger.trace(`${method} Completed`, { duration: ms(subscribed), emissions }),
    unsubscribe: (): void => logger.trace(`${method} Unsubscribed`, { duration: ms(subscribed), emissions }),
  };
};
