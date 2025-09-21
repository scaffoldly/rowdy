#!/usr/bin/env node

import { lastValueFrom, Observable, race, switchMap } from 'rxjs';
import { Environment } from './environment';
import { LambdaEnvironment } from './aws/lambda';

class EnvironmentFactory {
  static create(): Observable<Environment> {
    return race(LambdaEnvironment._create());
  }
}

const main = async (): Promise<void> => {
  await lastValueFrom(
    EnvironmentFactory.create().pipe(switchMap((env) => env.poll()))
  );
};

const error = (err: unknown): void => {
  process.stderr.write(
    `Error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
};

if (require.main === module) {
  main().catch(error);
}

export { Routes } from './routes';
