// Bundled the way rowdy is: rowdy-cdk and rxjs inlined; the AWS SDK and the host's SDK external.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { CdkInstrumentation } from '@scaffoldly/rowdy-cdk';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { from, mergeMap, Subject } from 'rxjs';
import { createServer } from 'http';

// Keeps what it is given: export can wait on resource detection, and is flushed only by shutdown.
const exported = [];
const exporter = {
  export: (spans, done) => done({ code: 0 }, exported.push(...spans)),
  shutdown: async () => {},
};
// HOST_PASSES=0: a host that starts its own SDK and never makes rowdy-cdk's instrumentations.
const sdk = new NodeSDK({
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
  ...(process.env.HOST_PASSES === '0' ? {} : { instrumentations: [CdkInstrumentation.create()] }),
});
sdk.start();

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
  trace.getTracer('test').startActiveSpan('subscriber', (span) => {
    subscriber = span.spanContext().spanId;
    requests
      .pipe(mergeMap(() => from(sts.send(new GetCallerIdentityCommand({})).catch(() => undefined))))
      .subscribe({ next: resolve });
    span.end();
  });
  context.with(ROOT_CONTEXT, () => requests.next(1));
});

server.close();
await sdk.shutdown();
const spans = exported.map((s) => ({
  name: s.name,
  scope: s.instrumentationScope.name,
  parent: s.parentSpanContext?.spanId,
  id: s.spanContext().spanId,
}));
process.stdout.write(JSON.stringify({ spans, subscriber }));
