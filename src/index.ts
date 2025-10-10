#!/usr/bin/env node

import { firstValueFrom, fromEvent, merge, takeUntil } from 'rxjs';
import { Environment } from './environment';
import { log } from './log';

async function main(): Promise<void> {
  const abort = new AbortController();
  const stop$ = merge(fromEvent(process, 'SIGINT'), fromEvent(process, 'SIGTERM'), fromEvent(abort.signal, 'abort'));

  const subscription = new Environment(abort, log).init().poll().pipe(takeUntil(stop$)).subscribe();
  abort.signal.addEventListener('abort', () => subscription.unsubscribe());

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

export { Routes, URI } from './routes';
