import { SeverityNumber, type Attributes, type Context, type Histogram, type MeterProvider } from '@opentelemetry/api';
import type { CdkInstrumentationOptions } from '../../otel';
import { wiretap } from './logging';
import type { Tracker } from './tracker';

const histograms = new WeakMap<MeterProvider, Map<string, Histogram>>();

const durationOn = (meterProvider: MeterProvider, name: string, version: string): Histogram => {
  let byName = histograms.get(meterProvider);
  if (!byName) histograms.set(meterProvider, (byName = new Map()));
  let histogram = byName.get(name);
  if (!histogram) {
    histogram = meterProvider.getMeter(name, version).createHistogram('cdk.trace.duration', {
      unit: 's',
      description: 'How long each run of a traced method took.',
    });
    byName.set(name, histogram);
  }
  return histogram;
};

/** Records a run's duration on the options' `meterProvider`, with its method, outcome and any error's type. */
export const measureRun = (method: string, options: Required<CdkInstrumentationOptions>, context: Context): Tracker => {
  const { meterProvider, name, version } = options;
  const histogram = durationOn(meterProvider, name, version);
  const tap = wiretap(options, context);
  const started = performance.now();
  // Each value is also a log record at TRACE: `Metric Recorded`.
  const record = (outcome: string, extra: Attributes = {}, at = performance.now()): void => {
    const value = (at - started) / 1000;
    const attributes = { 'code.function.name': method, 'cdk.trace.outcome': outcome, ...extra };
    histogram.record(value, attributes);
    tap(SeverityNumber.TRACE, 'Metric Recorded', { name: 'cdk.trace.duration', value: `${value} s`, ...attributes });
  };

  return {
    subscribe: (): void => {},
    emit: (): void => {},
    complete: (): void => record('complete'),
    fail: (error): void => record('error', { 'error.type': error instanceof Error ? error.name : typeof error }),
    unsubscribe: (): void => record('unsubscribe'),
    returned: (at): void => record('returned', {}, at),
  };
};
