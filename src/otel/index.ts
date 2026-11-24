import type { LoggerProvider, MeterProvider, TracerProvider } from '@opentelemetry/api';
import type { Instrumentation, InstrumentationConfig } from '@opentelemetry/instrumentation';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import type { CdkOptions } from '../cdk';
import { Logger } from '../log';
import { NOOP_METER_PROVIDER, NOOP_TRACER_PROVIDER } from './noop';
import { RxJSInstrumentation } from './rxjs';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version';

/** Where the instrumentations' spans, metrics and log records go; an SDK that registers them sets its own. */
export type CdkInstrumentationOptions = Pick<
  CdkOptions,
  'tracerProvider' | 'meterProvider' | 'loggerProvider' | 'logLevel'
>;

/**
 * aws-sdk, axios (its http adapter through http, its fetch adapter through undici), rxjs and
 * `@Trace`, controlled as one. Made when this package loads, so its hooks are in before the
 * libraries they patch load, and recording nothing until it has a tracer provider: from `create()`,
 * from a `@Trace(options)` call's options, or from an SDK that registers it:
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
  private given: CdkInstrumentationOptions = {};
  // Each enabled when made.
  private readonly members: Instrumentation[] = [
    new AwsInstrumentation(),
    new HttpInstrumentation(),
    new UndiciInstrumentation(),
    new RxJSInstrumentation(),
  ];

  private constructor(options: CdkInstrumentationOptions) {
    this.apply(options, true);
  }

  /**
   * The one CdkInstrumentation, made by the first call and returned by every later one, so its
   * instrumentations are never registered twice. Each call's options are merged over the ones it
   * has: what a call leaves out, or leaves undefined, it keeps.
   */
  static create(given: CdkInstrumentationOptions = {}): CdkInstrumentation {
    // Only its own four: a caller's options are often more, like credentials.
    const { tracerProvider, meterProvider, loggerProvider, logLevel } = given;
    const defined = Object.fromEntries(
      Object.entries({ tracerProvider, meterProvider, loggerProvider, logLevel }).filter(
        ([, value]) => value !== undefined
      )
    ) as CdkInstrumentationOptions;
    if (!CdkInstrumentation.instance) {
      return (CdkInstrumentation.instance = new CdkInstrumentation(defined));
    }
    CdkInstrumentation.instance.apply({ ...CdkInstrumentation.instance.given, ...defined });
    return CdkInstrumentation.instance;
  }

  /** Where spans go: the tracer provider it was last given, if any. */
  get tracerProvider(): TracerProvider | undefined {
    return this.given.tracerProvider;
  }

  /** Where metrics go: the meter provider it was last given, if any. */
  get meterProvider(): MeterProvider | undefined {
    return this.given.meterProvider;
  }

  /**
   * Where log records go: the logger provider it was last given, or else `Logger.defaults()`'s,
   * filtered at its logLevel, or else at the process-wide level.
   */
  get loggerProvider(): LoggerProvider {
    const { loggerProvider, logLevel } = this.given;
    // The default loggers filter at the process-wide level: a given logLevel needs loggers of its own.
    const base = loggerProvider ?? (logLevel ? Logger.at(logLevel) : Logger.defaults().loggerProvider!);
    return Logger.filter(base, logLevel);
  }

  /** All its options, filled in: providers that record nothing where none was given. */
  get options(): Required<CdkOptions> {
    return {
      tracerProvider: this.tracerProvider ?? NOOP_TRACER_PROVIDER,
      meterProvider: this.meterProvider ?? NOOP_METER_PROVIDER,
      loggerProvider: this.loggerProvider,
      logLevel: this.given.logLevel ?? Logger.defaults().logLevel!,
    };
  }

  /** Takes `next` as its options, handing the members the providers that changed: all of them at first. */
  private apply(next: CdkInstrumentationOptions, initial = false): void {
    const tracer = this.given.tracerProvider;
    const meter = this.given.meterProvider;
    const logger = initial ? undefined : this.loggerProvider;
    this.given = next;
    if (next.tracerProvider && next.tracerProvider !== tracer) {
      this.members.forEach((member) => member.setTracerProvider(next.tracerProvider!));
    }
    // Setting one rebuilds the members' metric instruments.
    if (next.meterProvider && next.meterProvider !== meter) {
      this.members.forEach((member) => member.setMeterProvider(next.meterProvider!));
    }
    const loggerProvider = this.loggerProvider;
    if (loggerProvider !== logger) {
      this.members.forEach((member) => member.setLoggerProvider?.(loggerProvider));
    }
  }

  enable(): void {
    this.members.forEach((member) => member.enable());
  }

  disable(): void {
    this.members.forEach((member) => member.disable());
  }

  setTracerProvider(tracerProvider: TracerProvider): void {
    this.apply({ ...this.given, tracerProvider });
  }

  setMeterProvider(meterProvider: MeterProvider): void {
    this.apply({ ...this.given, meterProvider });
  }

  setLoggerProvider(loggerProvider: LoggerProvider): void {
    this.apply({ ...this.given, loggerProvider });
  }

  setConfig(config: InstrumentationConfig): void {
    this.config = { ...config };
  }

  getConfig(): InstrumentationConfig {
    return this.config;
  }
}
