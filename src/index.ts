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
  log.info('Shutting Down');
}

const error = (error: Error): void => {
  log.error('Fatal Error', { error: error.message, stack: error.stack ?? '' });
  process.exit(1);
};

if (require.main === module) {
  main().catch(error);
}

export { Environment };
export { Crontab, Routes, URI, Volume } from './routes';
export { Logger, isLevel, mask, maskEnv, maskHeaders, maskJson, maskQuery, maskUrl } from './log';
export type { Format, Level } from './log';
export { Rowdy } from './api';
