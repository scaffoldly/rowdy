import type { Attributes, Histogram, MeterProvider } from '@opentelemetry/api';
import type { CdkOptions } from '../../cdk';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../otel/version';
import type { Tracker } from './tracker';

const histograms = new WeakMap<MeterProvider, Histogram>();

const durationOn = (meterProvider: MeterProvider): Histogram => {
  let histogram = histograms.get(meterProvider);
  if (!histogram) {
    histogram = meterProvider.getMeter(PACKAGE_NAME, PACKAGE_VERSION).createHistogram('cdk.trace.duration', {
      unit: 's',
      description: 'How long each run of a traced method took.',
    });
    histograms.set(meterProvider, histogram);
  }
  return histogram;
};

/** Records a run's duration on the options' `meterProvider`, with its method, outcome and any error's type. */
export const measureRun = (method: string, { meterProvider }: Required<CdkOptions>): Tracker => {
  const histogram = durationOn(meterProvider);
  const started = performance.now();
  const record = (outcome: string, extra: Attributes = {}, at = performance.now()): void =>
    histogram.record((at - started) / 1000, { 'code.function.name': method, 'cdk.trace.outcome': outcome, ...extra });

  return {
    subscribe: (): void => {},
    emit: (): void => {},
    complete: (): void => record('complete'),
    fail: (error): void => record('error', { 'error.type': error instanceof Error ? error.name : typeof error }),
    unsubscribe: (): void => record('unsubscribe'),
    returned: (at): void => record('returned', {}, at),
  };
};
