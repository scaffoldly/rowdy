import type { LoggerProvider, MeterProvider, TracerProvider } from '@opentelemetry/api';
import type { Instrumentation, InstrumentationConfig } from '@opentelemetry/instrumentation';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import type { CdkOptions } from '../internal/trace';
import { RxJSInstrumentation } from './rxjs';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version';

/** Where the instrumentations' spans, metrics and log records go; an SDK that registers them sets its own. */
export type CdkInstrumentationOptions = Pick<CdkOptions, 'tracerProvider' | 'meterProvider' | 'loggerProvider'>;

/**
 * aws-sdk, axios (its http adapter through http, its fetch adapter through undici) and rxjs, all four
 * on, as one instrumentation. Made when this package loads, so its hooks are in before the libraries
 * they patch load, and recording nothing until it has a tracer provider: the first `@Trace(options)`
 * call whose options carry `tracerProvider`, `meterProvider` or `loggerProvider` hands them over. An SDK can also
 * register it:
 *
 *     new NodeSDK({ serviceName: 'my-service', instrumentations: [CdkInstrumentation.create()] });
 *
 * rxjs is patched as this package imports it too, so a bundle that inlines it is covered; the AWS
 * SDK is patched only when required, so a bundle that inlines it gets no aws-sdk spans.
 */
export class CdkInstrumentation implements Instrumentation {
  private static instance?: CdkInstrumentation;

  readonly instrumentationName = PACKAGE_NAME;
  readonly instrumentationVersion = PACKAGE_VERSION;
  private config: InstrumentationConfig = { enabled: true };
  private tracerProvider?: TracerProvider;
  private meterProvider?: MeterProvider;
  private loggerProvider?: LoggerProvider;
  // Each enabled when made.
  private readonly members: Instrumentation[] = [
    new AwsInstrumentation(),
    new HttpInstrumentation(),
    new UndiciInstrumentation(),
    new RxJSInstrumentation(),
  ];

  private constructor() {}

  /**
   * The one CdkInstrumentation, made by the first call and returned by every later one, so its
   * instrumentations are never registered twice; given `tracerProvider`, `meterProvider` and
   * `loggerProvider` when passed and not the ones it already has.
   */
  static create({ tracerProvider, meterProvider, loggerProvider }: CdkInstrumentationOptions = {}): CdkInstrumentation {
    const instance = (CdkInstrumentation.instance ??= new CdkInstrumentation());
    if (tracerProvider && tracerProvider !== instance.tracerProvider) instance.setTracerProvider(tracerProvider);
    // Setting one rebuilds the members' metric instruments.
    if (meterProvider && meterProvider !== instance.meterProvider) instance.setMeterProvider(meterProvider);
    if (loggerProvider && loggerProvider !== instance.loggerProvider) instance.setLoggerProvider(loggerProvider);
    return instance;
  }

  static get instrumentations(): Instrumentation[] {
    return (CdkInstrumentation.instance ??= CdkInstrumentation.create()).members;
  }

  enable(): void {
    this.members.forEach((member) => member.enable());
  }

  disable(): void {
    this.members.forEach((member) => member.disable());
  }

  setTracerProvider(tracerProvider: TracerProvider): void {
    this.tracerProvider = tracerProvider;
    this.members.forEach((member) => member.setTracerProvider(tracerProvider));
  }

  setMeterProvider(meterProvider: MeterProvider): void {
    this.meterProvider = meterProvider;
    this.members.forEach((member) => member.setMeterProvider(meterProvider));
  }

  setLoggerProvider(loggerProvider: LoggerProvider): void {
    this.loggerProvider = loggerProvider;
    this.members.forEach((member) => member.setLoggerProvider?.(loggerProvider));
  }

  setConfig(config: InstrumentationConfig): void {
    this.config = { ...config };
  }

  getConfig(): InstrumentationConfig {
    return this.config;
  }
}
