import type { MeterProvider, TracerProvider } from '@opentelemetry/api';
import type { LoggerProvider } from '@opentelemetry/api-logs';
import { InstrumentationBase, type Instrumentation, type InstrumentationConfig } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../version';

/**
 * axios, as one instrumentation: its http adapter through http, which a bundle leaves to Node's
 * require as a built-in, and its fetch adapter through undici, which reports on diagnostics_channel.
 * Neither needs a patch of its own. Each is enabled when made.
 */
export class AxiosInstrumentation implements Instrumentation {
  readonly instrumentationName = `${PACKAGE_NAME}/axios`;
  readonly instrumentationVersion = PACKAGE_VERSION;
  private config: InstrumentationConfig = { enabled: true };
  private readonly members: InstrumentationBase[] = [new HttpInstrumentation(), new UndiciInstrumentation()];

  enable(): void {
    this.members.forEach((member) => member.enable());
  }

  disable(): void {
    this.members.forEach((member) => member.disable());
  }

  /** Whether both are enabled. */
  isEnabled(): boolean {
    return this.members.every((member) => member.isEnabled());
  }

  setTracerProvider(tracerProvider: TracerProvider): void {
    this.members.forEach((member) => member.setTracerProvider(tracerProvider));
  }

  setMeterProvider(meterProvider: MeterProvider): void {
    this.members.forEach((member) => member.setMeterProvider(meterProvider));
  }

  setLoggerProvider(loggerProvider: LoggerProvider): void {
    this.members.forEach((member) => member.setLoggerProvider(loggerProvider));
  }

  setConfig(config: InstrumentationConfig): void {
    this.config = { ...config };
  }

  getConfig(): InstrumentationConfig {
    return this.config;
  }
}
