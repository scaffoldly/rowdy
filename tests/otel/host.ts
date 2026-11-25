// A host of the SDK, bundled with it as a host's bundler would: rxjs, axios and the AWS SDK inlined, only
// OpenTelemetry's SDK left to node_modules. It prints what NodeSDK received, as JSON, for tests/otel.test.ts.
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { Subscriber } from 'rxjs';
// The 1.9 line, the oldest whose span parents rowdy keeps: rowdy-cdk bundles api 1.9.
import { metrics, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { Sandbox } from '../../src/sandbox';

const main = async (): Promise<void> => {
  const spans = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
  const records = new InMemoryLogRecordExporter();
  const sdk = new NodeSDK({
    spanProcessors: [new SimpleSpanProcessor(spans)],
    metricReaders: [reader],
    logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: records })],
    // rowdy-cdk brings its own.
    instrumentations: [],
  });
  sdk.start();

  // AWS and every registry, so nothing leaves the machine: AWS by its endpoint, axios by its proxy.
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (req.url?.includes('/v2/')) {
      res.statusCode = 404;
      res.end('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}');
      return;
    }
    res.end(JSON.stringify({ Functions: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    AWS_REGION: 'us-east-1',
    AWS_ENDPOINT_URL: local,
    HTTPS_PROXY: local,
    HTTP_PROXY: local,
  });

  const options = {
    credentials: async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example' }),
    tracerProvider: trace.getTracerProvider(),
    meterProvider: metrics.getMeterProvider(),
    loggerProvider: logs.getLoggerProvider(),
    // Span Ended is a debug line.
    logLevel: 'debug' as const,
  };
  await Sandbox.list({ runtime: 'aws.lambda', ...options });
  // It fails with no base image to build from, after it has asked a registry for rowdy's layer.
  await Sandbox.create({ runtime: 'aws.microvm', image: 'acme/app:latest', ...options }).catch(() => undefined);

  await reader.forceFlush();
  server.close();
  process.stdout.write(
    JSON.stringify({
      spans: spans.getFinishedSpans().map((span) => ({
        scope: span.instrumentationScope.name,
        name: span.name,
        id: span.spanContext().spanId,
        parent: span.parentSpanContext?.spanId,
        url: span.attributes['url.full'] ?? span.attributes['http.url'],
      })),
      metrics: metricExporter
        .getMetrics()
        .flatMap(({ scopeMetrics }) =>
          scopeMetrics.flatMap(({ scope, metrics }) =>
            metrics.map(({ descriptor }) => `${scope.name} ${descriptor.name}`)
          )
        ),
      logs: records
        .getFinishedLogRecords()
        .map(({ instrumentationScope, severityText, body }) => `${instrumentationScope.name} ${severityText} ${body}`),
      rxjs: '__original' in Subscriber.prototype.next,
    })
  );
  await sdk.shutdown();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
