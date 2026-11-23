import type { Instrumentation } from '@opentelemetry/instrumentation';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { RxJSInstrumentation } from './rxjs';

export { RxJSInstrumentation };

/**
 * For `new NodeSDK({ instrumentations: INSTRUMENTATIONS })`:
 * aws-sdk, axios (http adapter via http, fetch adapter via undici), and rxjs.
 */
export const INSTRUMENTATIONS: Instrumentation[] = [
  new AwsInstrumentation(),
  new HttpInstrumentation(),
  new UndiciInstrumentation(),
  new RxJSInstrumentation(),
];
