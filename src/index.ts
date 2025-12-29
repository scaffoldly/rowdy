#!/usr/bin/env node

import { firstValueFrom, fromEvent, merge, take, takeUntil, tap } from 'rxjs';
import { Environment } from './environment';
import { log } from './log';
import { ABORT } from './abort';

export { ABORT };

async function main(): Promise<void> {
  const stop$ = merge(
    fromEvent(process, 'SIGINT'),
    fromEvent(process, 'SIGTERM'),
    fromEvent(ABORT.signal, 'abort')
  ).pipe(
    take(1),
    tap(() => {
      log.info('Shutdown signal received');
      ABORT.abort();
    })
  );

  const subscription = new Environment(log).init().poll().pipe(takeUntil(stop$)).subscribe();
  ABORT.signal.addEventListener('abort', () => subscription.unsubscribe());

  await firstValueFrom(stop$);
  log.info('Shutting down.');
}

const error = (error: Error): void => {
  // eslint-disable-next-line no-console
  console.error(`Fatal Error: ${error.message}`, error.stack);
  process.exit(1);
};

if (require.main === module) {
  main().catch(error);
}

export { Environment };
export { Routes, URI } from './routes';
export { Logger } from './log';
export { Rowdy } from './api';
