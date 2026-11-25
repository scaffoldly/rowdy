import { context, createContextKey, createNoopMeter, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { createNoopLogger, SeverityNumber } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { execFileSync } from 'child_process';
import { join } from 'path';
import * as rxjs from 'rxjs';
import { type InstrumentationBase, isWrapped } from '@opentelemetry/instrumentation';
import type * as Otel from '../src/otel';
import { RxJSInstrumentation } from '../src/otel/rxjs/rxjs';

/** A fresh copy of the module and its rxjs: create() makes its instrumentations once. */
// Child processes print their results on stdout: keep @Trace's INFO wiretaps off it. Jest's
// process.env is a copy of its own, so it is passed to each explicitly.
const QUIET = { ...process.env, ROWDY_LOG_LEVEL: 'warn' };

const fresh = (): { CdkInstrumentation: typeof Otel.CdkInstrumentation; rx: typeof rxjs } => {
  let loaded: ReturnType<typeof fresh> | undefined;
  jest.isolateModules(() => {
    loaded = {
      CdkInstrumentation: (require('../src/otel') as typeof Otel).CdkInstrumentation,
      rx: require('rxjs'),
    };
  });
  return loaded!;
};

describe('CdkInstrumentation.create', () => {
  const members = (cdk: Otel.CdkInstrumentation): InstrumentationBase[] =>
    (cdk as unknown as { members: InstrumentationBase[] }).members;

  it('holds aws-sdk, http, undici and rxjs, each enabled', () => {
    const { CdkInstrumentation, rx } = fresh();
    const cdk = CdkInstrumentation.create();
    try {
      expect(members(cdk).map((i) => i.constructor.name)).toEqual([
        'AwsInstrumentation',
        'AxiosInstrumentation',
        'RxJSInstrumentation',
      ]);
      expect(members(cdk).map((i) => i.isEnabled())).toEqual([true, true, true]);
      expect(cdk.getConfig().enabled).toBe(true);
      expect(isWrapped(rx.Observable.prototype.subscribe)).toBe(true);
    } finally {
      cdk.disable();
    }
    expect(members(cdk).map((i) => i.isEnabled())).toEqual([false, false, false]);
    expect(isWrapped(rx.Observable.prototype.subscribe)).toBe(false);
  });

  it('makes one per process: a later call returns the same one', () => {
    const { CdkInstrumentation } = fresh();
    const cdk = CdkInstrumentation.create();
    try {
      expect(CdkInstrumentation.create()).toBe(cdk);
    } finally {
      cdk.disable();
    }
  });

  it('hands its tracer, meter and logger providers to every member, and the same ones only once', () => {
    const { CdkInstrumentation } = fresh();
    const tracerProvider = { getTracer: jest.fn(() => trace.getTracer('noop')) };
    const meterProvider = { getMeter: jest.fn(() => createNoopMeter()) };
    const loggerProvider = { getLogger: jest.fn(() => createNoopLogger()) };
    const cdk = CdkInstrumentation.create({ tracerProvider, meterProvider, loggerProvider });
    try {
      const calls = (): number[] =>
        [tracerProvider, meterProvider, loggerProvider].map((p) => Object.values(p)[0]!.mock.calls.length);
      const first = calls();
      expect(first.every((n) => n >= 4)).toBe(true);
      CdkInstrumentation.create({ tracerProvider, meterProvider, loggerProvider });
      expect(calls()).toEqual(first);
    } finally {
      cdk.disable();
    }
  });

  it('merges each call over the options it has: what a call leaves out or undefined, it keeps', () => {
    const { CdkInstrumentation } = fresh();
    const first = { getTracer: jest.fn(() => trace.getTracer('noop')) };
    const second = { getTracer: jest.fn(() => trace.getTracer('noop')) };
    const cdk = CdkInstrumentation.create({ tracerProvider: first });
    try {
      CdkInstrumentation.create({ logLevel: 'warn' });
      CdkInstrumentation.create({ tracerProvider: undefined });
      expect(cdk.tracerProvider).toBe(first);
      CdkInstrumentation.create({ tracerProvider: second });
      expect(cdk.tracerProvider).toBe(second);
      expect(cdk.loggerProvider.getLogger('x').enabled({ severityNumber: SeverityNumber.INFO })).toBe(false);
    } finally {
      cdk.disable();
    }
  });

  it('keeps its loggerProvider through calls that leave it out or undefined, until a null unsets it', () => {
    const { CdkInstrumentation } = fresh();
    const getLogger = jest.fn(() => createNoopLogger());
    const probes = (): number => {
      CdkInstrumentation.create().loggerProvider.getLogger('probe');
      return getLogger.mock.calls.filter(([name]: unknown[]) => name === 'probe').length;
    };
    const cdk = CdkInstrumentation.create({ loggerProvider: { getLogger } });
    try {
      CdkInstrumentation.create({ logLevel: undefined });
      CdkInstrumentation.create({ loggerProvider: undefined });
      expect(probes()).toBe(1);
      CdkInstrumentation.create({ loggerProvider: null });
      CdkInstrumentation.create({});
      expect(probes()).toBe(1);
    } finally {
      cdk.disable();
    }
  });

  it("filters the members' log records at its logLevel", () => {
    const { CdkInstrumentation } = fresh();
    const emit = jest.fn();
    const loggerProvider = {
      getLogger: (): { emit: jest.Mock; enabled: () => boolean } => ({ emit, enabled: (): boolean => true }),
    };
    const cdk = CdkInstrumentation.create({ loggerProvider, logLevel: 'warn' });
    try {
      const { logger } = members(cdk)[0] as unknown as { logger: { emit(record: object): void } };
      logger.emit({ severityNumber: SeverityNumber.INFO, body: 'dropped' });
      logger.emit({ severityNumber: SeverityNumber.ERROR, body: 'kept' });
      expect(emit.mock.calls.map(([record]) => record.body)).toEqual(['kept']);
    } finally {
      cdk.disable();
    }
  });

  it('sends spans to the tracerProvider passed to create, with no SDK', () => {
    // A child process: the aws-sdk instrumentation patches through Node's real require, which jest bypasses.
    const script = `
      const { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } = require('@opentelemetry/sdk-trace');
      const { CdkInstrumentation } = require(${JSON.stringify(join(__dirname, '..', 'dist', 'index.js'))});
      const exporter = new InMemorySpanExporter();
      const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
      CdkInstrumentation.create({ tracerProvider });
      const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
      const server = require('http').createServer((_req, res) => res.end('<x/>'));
      server.listen(0, '127.0.0.1', async () => {
        const sts = new STSClient({
          region: 'us-east-1',
          endpoint: 'http://127.0.0.1:' + server.address().port,
          credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
          maxAttempts: 1,
        });
        await sts.send(new GetCallerIdentityCommand({})).catch(() => undefined);
        server.close();
        await tracerProvider.forceFlush();
        console.log(JSON.stringify(exporter.getFinishedSpans().map((s) => s.name)));
      });
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      env: QUIET,
    });
    expect(JSON.parse(out)).toContain('STS.GetCallerIdentity');
  });
});

describe('RxJSInstrumentation', () => {
  const KEY = createContextKey('test');
  const ctxA = ROOT_CONTEXT.setValue(KEY, 'a');
  const current = (): unknown => context.active().getValue(KEY);
  const definition = new RxJSInstrumentation({ enabled: false }).getModuleDefinitions()[0]!;

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });

  afterAll(() => {
    context.disable();
  });

  beforeEach(() => {
    definition.patch!(rxjs, '7.8.2');
  });

  afterEach(() => {
    definition.unpatch!(rxjs, '7.8.2');
  });

  it('targets rxjs >=7', () => {
    expect(definition.name).toBe('rxjs');
    expect(definition.supportedVersions).toEqual(['>=7']);
  });

  it('runs callbacks in the context active at subscribe', () => {
    const subject = new rxjs.Subject<number>();
    const seen: unknown[] = [];
    context.with(ctxA, () =>
      subject.subscribe({
        next: () => seen.push(['next', current()]),
        complete: () => seen.push(['complete', current()]),
      })
    );
    context.with(ctxA, () => subject.subscribe((n) => seen.push([n, current()])));
    subject.next(1);
    subject.complete();
    expect(seen).toEqual([
      ['next', 'a'],
      [1, 'a'],
      ['complete', 'a'],
    ]);
  });

  it('keeps an observer object as this', () => {
    const subject = new rxjs.Subject<number>();
    const observer = {
      seen: [] as unknown[],
      next(this: { seen: unknown[] }, n: number): void {
        this.seen.push(n);
      },
    };
    context.with(ctxA, () => subject.subscribe(observer));
    subject.next(1);
    expect(observer.seen).toEqual([1]);
  });

  it('keeps operator chains and unsubscribe working', () => {
    const subject = new rxjs.Subject<number>();
    const seen: unknown[] = [];
    const subscription = context.with(ctxA, () =>
      subject.pipe(rxjs.map((n) => n * 2)).subscribe((n) => seen.push([n, current()]))
    );
    subject.next(1);
    subscription.unsubscribe();
    subject.next(2);
    expect(seen).toEqual([[2, 'a']]);
    expect(subject.observed).toBe(false);
  });

  it('patches the rxjs it imports on enable and restores it on disable', () => {
    definition.unpatch!(rxjs, '7.8.2');
    const instrumentation = new RxJSInstrumentation({ enabled: false });
    expect(isWrapped(rxjs.Observable.prototype.subscribe)).toBe(false);
    instrumentation.enable();
    const subject = new rxjs.Subject<number>();
    const seen: unknown[] = [];
    context.with(ctxA, () => subject.subscribe(() => seen.push(current())));
    subject.next(1);
    expect(seen).toEqual(['a']);
    instrumentation.disable();
    expect(isWrapped(rxjs.Observable.prototype.subscribe)).toBe(false);
  });

  it('restores subscribe on unpatch', () => {
    definition.unpatch!(rxjs, '7.8.2');
    expect(isWrapped(rxjs.Subscriber.prototype.next)).toBe(false);
    const subject = new rxjs.Subject<number>();
    const seen: unknown[] = [];
    context.with(ctxA, () => subject.subscribe(() => seen.push(current())));
    subject.next(1);
    expect(seen).toEqual([undefined]);
  });

  describe('when something else emits', () => {
    const emitter = ROOT_CONTEXT.setValue(KEY, 'emitter');
    const ctxB = ROOT_CONTEXT.setValue(KEY, 'b');

    const run = async (
      build: (subject: rxjs.Subject<number>, log: (tag: string) => void) => void,
      emit: (subject: rxjs.Subject<number>) => void = (subject): void => {
        subject.next(1);
        subject.complete();
      }
    ): Promise<string[]> => {
      const subject = new rxjs.Subject<number>();
      const seen: string[] = [];
      context.with(ctxA, () => build(subject, (tag) => seen.push(`${tag}:${current() ?? 'root'}`)));
      context.with(emitter, () => emit(subject));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return seen;
    };

    it('runs map and tap in the context active at subscribe', async () => {
      const seen = await run((s, log) =>
        s
          .pipe(
            rxjs.map((n) => (log('map'), n)),
            rxjs.tap(() => log('tap'))
          )
          .subscribe(() => log('next'))
      );
      expect(seen).toEqual(['map:a', 'tap:a', 'next:a']);
    });

    it('runs a mergeMap project and its inner observable in the context active at subscribe', async () => {
      const seen = await run((s, log) =>
        s
          .pipe(rxjs.mergeMap((n) => (log('project'), rxjs.defer(() => (log('inner'), rxjs.of(n))))))
          .subscribe(() => log('next'))
      );
      expect(seen).toEqual(['project:a', 'inner:a', 'next:a']);
    });

    it('runs error callbacks in the context active at subscribe', async () => {
      const seen = await run(
        (s, log) =>
          s.pipe(rxjs.catchError(() => (log('catchError'), rxjs.EMPTY))).subscribe({ complete: () => log('complete') }),
        (s) => s.error(new Error('boom'))
      );
      expect(seen).toEqual(['catchError:a', 'complete:a']);
    });

    it('runs delayed emissions in the context active at subscribe', async () => {
      const seen = await run((s, log) => s.pipe(rxjs.delay(5)).subscribe(() => log('next')));
      expect(seen).toEqual(['next:a']);
    });

    it('runs operators upstream of share in the first subscriber context, and each subscriber in its own', async () => {
      const seen = await run((s, log) => {
        const shared = s.pipe(
          rxjs.map((n) => (log('map'), n)),
          rxjs.share()
        );
        shared.subscribe(() => log('next1'));
        context.with(ctxB, () => shared.subscribe(() => log('next2')));
      });
      expect(seen).toEqual(['map:a', 'next1:a', 'next2:b']);
    });

    it('runs forEach in the context active at forEach', async () => {
      const seen = await run((s, log) => void s.forEach(() => log('forEach')));
      expect(seen).toEqual(['forEach:a']);
    });

    it('runs finalize in the context active at subscribe on complete', async () => {
      const seen = await run((s, log) => s.pipe(rxjs.finalize(() => log('finalize'))).subscribe());
      expect(seen).toEqual(['finalize:a']);
    });

    it('runs finalize in the context active at subscribe on unsubscribe from elsewhere', async () => {
      let subscription: rxjs.Subscription | undefined;
      const seen = await run(
        (s, log) => {
          subscription = s.pipe(rxjs.finalize(() => log('finalize'))).subscribe();
        },
        () => subscription!.unsubscribe()
      );
      expect(seen).toEqual(['finalize:a']);
    });
  });
});

const ROOT = join(__dirname, '..');

describe.each([
  ['CdkInstrumentation.create() from the main entry, given to the SDK', join(ROOT, 'dist', 'index.js'), 'pass'],
])('%s', (_name, entry, exportName) => {
  type Span = { name: string; scope: string; url?: string; rpcService?: string; parent?: string; id: string };
  let result: { spans: Span[]; rxjs: boolean[]; mergeMapParent: string };

  beforeAll(() => {
    result = JSON.parse(
      execFileSync(
        process.execPath,
        [join(__dirname, 'fixtures', 'otel-sdk.js'), entry, exportName, join(ROOT, 'dist', 'index.js')],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: QUIET,
        }
      )
    );
  });

  const client = (scope: string, path: string): Span | undefined =>
    result.spans.find((s) => s.scope === scope && s.url?.endsWith(path));

  it('traces axios over its http adapter', () => {
    expect(client('@opentelemetry/instrumentation-http', '/axios-http')).toBeDefined();
  });

  it('traces axios over its fetch adapter', () => {
    expect(client('@opentelemetry/instrumentation-undici', '/axios-fetch')).toBeDefined();
  });

  it('traces aws-sdk commands', () => {
    expect(result.spans).toContainEqual(
      expect.objectContaining({ scope: '@opentelemetry/instrumentation-aws-sdk', rpcService: 'STS' })
    );
  });

  it('keeps the active span in rxjs callbacks', () => {
    expect(result.rxjs).toEqual([true]);
  });

  it('makes a @Trace span that parents the requests it makes', () => {
    const traced = result.spans.find((s) => s.name === 'fetchTraced');
    expect(traced?.scope).toBe('@scaffoldly/rowdy-cdk');
    expect(client('@opentelemetry/instrumentation-http', '/traced')?.parent).toBe(traced?.id);
  });

  it('parents a request made in mergeMap on the span active at subscribe', () => {
    const request = client('@opentelemetry/instrumentation-http', '/rxjs-mergeMap');
    expect(request?.parent).toBe(result.mergeMapParent);
  });
});

describe('a host that never gives them a tracer provider', () => {
  let result: { spans: Array<{ name: string; scope: string }> };

  beforeAll(() => {
    result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(__dirname, 'fixtures', 'otel-sdk.js'),
          join(ROOT, 'dist', 'index.js'),
          'none',
          join(ROOT, 'dist', 'index.js'),
        ],
        { cwd: ROOT, encoding: 'utf8', env: QUIET }
      )
    );
  });

  it('records nothing from aws-sdk, http or undici', () => {
    expect(result.spans.filter((s) => s.scope.startsWith('@opentelemetry/instrumentation-'))).toEqual([]);
  });

  it('makes no @Trace span either: without a tracer provider, nothing is recorded', () => {
    expect(result.spans.map((s) => s.name)).not.toContain('fetchTraced');
  });
});

describe('CdkInstrumentation under ESM', () => {
  it('patches rxjs that was statically imported first', () => {
    const script = `
      import { Subject } from 'rxjs';
      import { NodeSDK } from '@opentelemetry/sdk-node';
      import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
      import { trace } from '@opentelemetry/api';
      import { CdkInstrumentation } from ${JSON.stringify(join(ROOT, 'dist', 'index.js'))};
      const sdk = new NodeSDK({
        spanProcessors: [new SimpleSpanProcessor({ exporter: new InMemorySpanExporter() })],
        instrumentations: [CdkInstrumentation.create()],
      });
      sdk.start();
      const subject = new Subject();
      const seen = [];
      trace.getTracer('test').startActiveSpan('parent', (span) => {
        subject.subscribe(() => seen.push(trace.getActiveSpan() === span));
        span.end();
      });
      subject.next(1);
      await sdk.shutdown();
      console.log(JSON.stringify(seen));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      encoding: 'utf8',
      env: QUIET,
    });
    expect(JSON.parse(out)).toEqual([true]);
  });
});

describe('@Trace on an async method nobody awaits', () => {
  it('leaves its failure an unhandled rejection, as it would be untraced', () => {
    // A child process: jest reports an unhandled rejection itself, before a listener sees it.
    const script = `
      const { Trace } = require(${JSON.stringify(join(ROOT, 'dist', 'index.js'))});
      const seen = [];
      process.on('unhandledRejection', (error) => seen.push(error.message));
      const untraced = async () => { throw new Error('untraced'); };
      const traced = Trace()(async () => { throw new Error('traced'); }, { kind: 'method', name: 'fails', static: false });
      untraced();
      traced();
      setTimeout(() => console.log(JSON.stringify(seen)), 20);
    `;
    const out = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', env: QUIET });
    expect(JSON.parse(out)).toEqual(['untraced', 'traced']);
  });
});

describe('rowdy.run passing its providers to a traced call', () => {
  type Span = { name: string; scope: string; parent?: string; id: string };

  // rowdy loads rowdy-cdk, then its AWS clients; rowdy.run starts its own SDK, registering nothing.
  const run = (passes: boolean): Span[] => {
    const script = `
      const { NodeSDK } = require('@opentelemetry/sdk-node');
      const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace');
      const { metrics, trace } = require('@opentelemetry/api');
      const { logs } = require('@opentelemetry/api-logs');
      const { Trace } = require(${JSON.stringify(join(ROOT, 'dist', 'index.js'))});
      const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');

      const exported = [];
      const exporter = { export: (spans, done) => done({ code: 0 }, exported.push(...spans)), shutdown: async () => {} };
      const sdk = new NodeSDK({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
      sdk.start();

      const server = require('http').createServer((_req, res) => res.end('<x/>'));
      server.listen(0, '127.0.0.1', async () => {
        const sts = new STSClient({
          region: 'us-east-1',
          endpoint: 'http://127.0.0.1:' + server.address().port,
          credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
          maxAttempts: 1,
        });
        // SandboxImpl.create, as @Trace((options) => options) decorates it.
        const create = Trace((options) => options)(
          async function () { await sts.send(new GetCallerIdentityCommand({})).catch(() => undefined); },
          { kind: 'method', name: 'create', static: true }
        );
        const options = ${passes}
          ? { tracerProvider: trace.getTracerProvider(), meterProvider: metrics.getMeterProvider(), loggerProvider: logs.getLoggerProvider() }
          : {};
        await create.call({ name: 'SandboxImpl' }, options);
        server.close();
        await sdk.shutdown();
        const spans = exported.map((s) => ({
          name: s.name, scope: s.instrumentationScope.name, parent: s.parentSpanContext?.spanId, id: s.spanContext().spanId,
        }));
        console.log(JSON.stringify(spans));
      });
    `;
    return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', env: QUIET }));
  };

  it('traces the call, the AWS SDK under it, and its request under that', () => {
    const spans = run(true);
    const create = spans.find((s) => s.name === 'SandboxImpl.create');
    const aws = spans.find((s) => s.name === 'STS.GetCallerIdentity');
    expect(aws?.parent).toBe(create?.id);
    expect(spans).toContainEqual(
      expect.objectContaining({ scope: '@opentelemetry/instrumentation-http', parent: aws?.id })
    );
  });

  it('records nothing when the call carries no providers', () => {
    expect(run(false)).toEqual([]);
  });
});

describe('a host on its own @opentelemetry/api', () => {
  // The host registers through its copy; the bundle reads them through its own, 1.9.
  const run = (api: string): { traced?: string; parent?: string; scope?: string } => {
    const script = `
      const api = require(${JSON.stringify(api)});
      const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
      const { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } = require('@opentelemetry/sdk-trace');
      const { CdkInstrumentation, Trace } = require(${JSON.stringify(join(ROOT, 'dist', 'index.js'))});
      const exporter = new InMemorySpanExporter();
      api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      api.trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));
      CdkInstrumentation.create({ tracerProvider: api.trace.getTracerProvider() });
      const list = Trace(
        async function () {
          await new Promise((resolve) => setTimeout(resolve, 1));
          api.trace.getTracer('host').startSpan('child').end();
        },
        { kind: 'method', name: 'list', static: true }
      );
      list.call({ name: 'SandboxImpl' }).then(() => {
        const spans = exporter.getFinishedSpans();
        const traced = spans.find((s) => s.name === 'SandboxImpl.list');
        const child = spans.find((s) => s.name === 'child');
        console.log(JSON.stringify({
          traced: traced && traced.spanContext().spanId,
          parent: child && child.parentSpanContext && child.parentSpanContext.spanId,
          scope: traced && traced.instrumentationScope.name,
        }));
      });
    `;
    return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', env: QUIET }));
  };

  it.each(['otel-api-1.9.0', 'otel-api-1.10.0'])('keeps a child span under the traced call with %s', (api) => {
    const { traced, parent, scope } = run(api);
    expect(scope).toBe('@scaffoldly/rowdy-cdk');
    expect(traced).toEqual(expect.any(String));
    expect(parent).toBe(traced);
  });
});
