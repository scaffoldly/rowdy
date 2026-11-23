// Runs in a child process: instrumentations patch modules through Node's real require, which jest bypasses.
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace');
const exported = require(process.argv[2])[process.argv[3]];

const exporter = new InMemorySpanExporter();
const sdk = new NodeSDK({
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
  instrumentations: exported,
});
sdk.start();

const http = require('http');
const { trace, context, ROOT_CONTEXT } = require('@opentelemetry/api');
const axios = require('axios');
const { Subject, mergeMap, from } = require('rxjs');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');

const main = async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  await axios.get(`${url}/axios-http`);
  await axios.get(`${url}/axios-fetch`, { adapter: 'fetch' });

  const sts = new STSClient({
    region: 'us-east-1',
    endpoint: url,
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    maxAttempts: 1,
  });
  await sts.send(new GetCallerIdentityCommand({})).catch(() => undefined);

  const subject = new Subject();
  const seen = [];
  const tracer = trace.getTracer('test');
  tracer.startActiveSpan('rxjs-parent', (span) => {
    subject.subscribe(() => seen.push(trace.getActiveSpan()?.spanContext().spanId === span.spanContext().spanId));
    span.end();
  });
  context.with(ROOT_CONTEXT, () => subject.next(1));

  const requests = new Subject();
  let mergeMapParent;
  await new Promise((resolve) => {
    tracer.startActiveSpan('rxjs-mergeMap-parent', (span) => {
      mergeMapParent = span.spanContext().spanId;
      requests.pipe(mergeMap(() => from(axios.get(`${url}/rxjs-mergeMap`)))).subscribe({ next: resolve });
      span.end();
    });
    context.with(ROOT_CONTEXT, () => requests.next(1));
  });

  server.close();

  // The in-memory exporter forgets its spans on shutdown.
  const spans = exporter.getFinishedSpans().map((s) => ({
    name: s.name,
    scope: s.instrumentationScope.name,
    url: s.attributes['url.full'] ?? s.attributes['http.url'],
    rpcService: s.attributes['rpc.service'],
    parent: s.parentSpanContext?.spanId,
  }));
  await sdk.shutdown();
  process.stdout.write(JSON.stringify({ spans, rxjs: seen, mergeMapParent }));
};

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(1);
});
