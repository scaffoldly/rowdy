// Bundled the way tsup bundles rowdy: everything inlined, the AWS SDK and rxjs included.
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { CdkInstrumentation } from '@scaffoldly/rowdy-cdk';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { from, mergeMap, Subject } from 'rxjs';
import { createServer } from 'http';

const main = async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const exporter = new InMemorySpanExporter();
  const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  CdkInstrumentation.create({ tracerProvider });

  const server = createServer((_req, res) => res.end('<x/>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sts = new STSClient({
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${server.address().port}`,
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    maxAttempts: 1,
  });

  // Subscribed under `subscriber`, emitted from the root context: only the rxjs patch parents the call.
  const requests = new Subject();
  let subscriber;
  await new Promise((resolve) => {
    tracerProvider.getTracer('test').startActiveSpan('subscriber', (span) => {
      subscriber = span.spanContext().spanId;
      requests
        .pipe(mergeMap(() => from(sts.send(new GetCallerIdentityCommand({})).catch(() => undefined))))
        .subscribe({ next: resolve });
      span.end();
    });
    context.with(ROOT_CONTEXT, () => requests.next(1));
  });

  server.close();
  await tracerProvider.forceFlush();
  const spans = exporter.getFinishedSpans().map((s) => ({
    name: s.name,
    scope: s.instrumentationScope.name,
    parent: s.parentSpanContext?.spanId,
  }));
  process.stdout.write(JSON.stringify({ spans, subscriber }));
};

main();
