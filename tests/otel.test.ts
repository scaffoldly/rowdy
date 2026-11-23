import { context, createContextKey, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { execFileSync } from 'child_process';
import { join } from 'path';
import * as rxjs from 'rxjs';
import { isWrapped } from '@opentelemetry/instrumentation';
import { INSTRUMENTATIONS } from '@scaffoldly/rowdy-cdk';
import { RxJSInstrumentation } from '@scaffoldly/rowdy-cdk/otel';

describe('INSTRUMENTATIONS', () => {
  it('lists aws-sdk, http, undici and rxjs', () => {
    expect(INSTRUMENTATIONS.map((i) => i.constructor)).toEqual([
      AwsInstrumentation,
      HttpInstrumentation,
      UndiciInstrumentation,
      RxJSInstrumentation,
    ]);
  });

  it('is enabled on import and patches rxjs', () => {
    expect(INSTRUMENTATIONS.map((i) => i.getConfig().enabled)).toEqual([true, true, true, true]);
    expect(isWrapped(rxjs.Observable.prototype.subscribe)).toBe(true);
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
  ['INSTRUMENTATIONS from /otel', join(ROOT, 'dist', 'otel'), 'INSTRUMENTATIONS'],
  ['INSTRUMENTATIONS from the main entry', join(ROOT, 'dist', 'index.js'), 'INSTRUMENTATIONS'],
])('%s in a NodeSDK', (_name, entry, exportName) => {
  type Span = { name: string; scope: string; url?: string; rpcService?: string; parent?: string };
  let result: { spans: Span[]; rxjs: boolean[]; mergeMapParent: string };

  beforeAll(() => {
    result = JSON.parse(
      execFileSync(process.execPath, [join(__dirname, 'fixtures', 'otel-sdk.js'), entry, exportName], {
        cwd: ROOT,
        encoding: 'utf8',
      })
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

  it('parents a request made in mergeMap on the span active at subscribe', () => {
    const request = client('@opentelemetry/instrumentation-http', '/rxjs-mergeMap');
    expect(request?.parent).toBe(result.mergeMapParent);
  });
});

describe('INSTRUMENTATIONS under ESM', () => {
  it('patches rxjs that was statically imported first', () => {
    const script = `
      import { Subject } from 'rxjs';
      import { NodeSDK } from '@opentelemetry/sdk-node';
      import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
      import { trace } from '@opentelemetry/api';
      import { INSTRUMENTATIONS } from ${JSON.stringify(join(ROOT, 'dist', 'index.js'))};
      const sdk = new NodeSDK({
        spanProcessors: [new SimpleSpanProcessor({ exporter: new InMemorySpanExporter() })],
        instrumentations: INSTRUMENTATIONS,
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
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual([true]);
  });
});
