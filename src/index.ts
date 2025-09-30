#!/usr/bin/env node

import { lastValueFrom } from 'rxjs';
import { Environment } from './environment';
import { log } from './log';

const main = async (): Promise<void> => {
  log.info('Starting environment');
  await lastValueFrom(new Environment().poll());
};

const error = (error: Error): void => {
  // eslint-disable-next-line no-console
  console.error(`Fatal Error: ${error.message}`, error.stack);
  process.exit(1);
};

if (require.main === module) {
  main().catch(error);
}

export { Routes } from './routes';
