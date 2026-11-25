import {
  context,
  SeverityNumber,
  SpanKind,
  SpanStatusCode,
  trace,
  type Logger as OtelLogger,
  type LoggerProvider,
  type LogRecord,
  type MeterProvider,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { defer, lastValueFrom, Observable, of, throwError, race, timer, map, NEVER, retry } from 'rxjs';
import pino from 'pino';
import {
  ILoggable,
  log,
  Logger,
  mask,
  maskEnv,
  maskHeaders,
  maskJson,
  maskQuery,
  maskUrl,
  type Level,
  type Sink,
} from '../src/log';
import type { CdkOptions } from '../src/cdk';
import { Trace } from '../src/internal/trace';
import { CdkInstrumentation } from '../src/otel';

describe('log masking', () => {
  describe('mask', () => {
    it('keeps a short prefix and suffix and the length', () => {
      expect(mask('ghp_0123456789abcdefghijklmnopqrstuvwxyz')).toBe('ghp_…wxyz (40 chars)');
      expect(mask('ASIAZDG6SNT5EXAMPLE1')).toBe('AS…E1 (20 chars)');
    });

    it('never reveals more than a quarter of the string', () => {
      for (const length of [8, 9, 15, 16, 31, 32, 64, 500]) {
        const value = 'x'.repeat(length);
        const shown = mask(value).split(' (')[0]!.replace('…', '').length;
        expect(shown).toBeLessThanOrEqual(length / 4);
        expect(shown).toBeLessThanOrEqual(8);
      }
    });

    it('shows nothing but the length for short values', () => {
      expect(mask('hunter2')).toBe('… (7 chars)');
      expect(mask('')).toBe('… (0 chars)');
      expect(mask(undefined)).toBe('… (0 chars)');
    });
  });

  it('maskEnv keeps every name and masks every value', () => {
    const out = maskEnv({ CF_API_TOKEN: 'cf-0123456789abcdef0123456789abcdef', PATH: '/usr/bin', EMPTY: undefined });
    expect(out).toBe('[CF_API_TOKEN=cf-0…cdef (35 chars), PATH=/…n (8 chars), EMPTY=… (0 chars)]');
    expect(out).not.toContain('0123456789abcdef0123456789abcdef');
  });

  it('maskEnv shows the values of names in plain as they are', () => {
    const out = maskEnv(
      { CF_API_TOKEN: 'cf-0123456789abcdef0123456789abcdef', HTTP_HOST: 'nuss.io', UNSET: undefined },
      new Set(['HTTP_HOST', 'UNSET'])
    );
    expect(out).toBe('[CF_API_TOKEN=cf-0…cdef (35 chars), HTTP_HOST=nuss.io, UNSET=]');
  });

  describe('maskHeaders', () => {
    it('masks credential headers by name, case-insensitively, and keeps the rest readable', () => {
      const out = maskHeaders({
        Host: 'nuss.io',
        Authorization: 'token gho_canarycanarycanarycanarycanary1234',
        cookie: 'session=canary-cookie-value-0123456789',
        'X-Api-Key': 'canary-api-key-0123456789abcdef',
        'x-console-token': 'hunter2',
        'x-amz-security-token': 'canary-sts-0123456789abcdefghijklmnopqrstuvwxyz',
        'user-agent': 'curl/8.7.1',
      });
      expect(out).toContain('Host=nuss.io');
      expect(out).toContain('user-agent=curl/8.7.1');
      expect(out).toContain('Authorization=toke…1234 (44 chars)');
      expect(out).toContain('x-console-token=… (7 chars)');
      for (const canary of ['canarycanary', 'canary-cookie', 'canary-api-key', 'hunter2', 'canary-sts']) {
        expect(out).not.toContain(canary);
      }
    });

    it('masks each value of a repeated header and query secrets inside URL-valued headers', () => {
      const out = maskHeaders({
        'set-cookie': ['a=canary-cookie-one-0123456789', 'b=canary-cookie-two-0123456789'],
        referer: 'https://example.com/cb?code=ok&access_token=canary-referer-token-0123456789',
      });
      expect(out).not.toContain('canary-cookie');
      expect(out).not.toContain('canary-referer-token');
      expect(out).toContain('referer=https://example.com/cb?code=… (2 chars)&access_token=');
      expect(out.match(/chars\)/g)).toHaveLength(4);
    });
  });

  describe('maskQuery and maskUrl', () => {
    it('keeps parameter names and masks sensitive-named values', () => {
      expect(maskQuery('page=2&token=canary-query-token-0123456789')).toBe('page=2&token=can…789 (29 chars)');
      expect(maskQuery('')).toBe('');
    });

    it('masks one-time codes, keys and signatures by whole-word name, not by substring', () => {
      const secret = 'canary-0123456789-abcdef';
      const sensitive = ['code', 'auth_code', 'key', 'apikey', 'api_key', 'x-api-key', 'sig', 'X-Amz-Signature'];
      for (const name of [...sensitive, 'otp', 'jwt', 'pin', 'id_token', 'passcode']) {
        expect(maskQuery(`${name}=${secret}`)).not.toContain(secret);
      }
      for (const name of ['keyword', 'encoded', 'design', 'postcode', 'content-encoding', 'page', 'spinner', 'state']) {
        expect(maskQuery(`${name}=${secret}`)).toBe(`${name}=${secret}`);
      }
    });

    it('masks a URL password and sensitive query values, and leaves the rest of the URL alone', () => {
      const out = maskUrl(
        'https://user:canary-password-0123456789@example.com:8443/a/b?x=1&api_key=canary-key-0123456789#frag'
      );
      expect(out).toBe('https://user:can…789 (26 chars)@example.com:8443/a/b?x=1&api_key=ca…89 (21 chars)#frag');
    });

    it('passes through URLs with nothing to mask, opaque URLs and non-URLs', () => {
      expect(maskUrl('http://localhost:3000/health')).toBe('http://localhost:3000/health');
      expect(maskUrl('rowdy://http:404/')).toBe('rowdy://http:404/');
      expect(maskUrl('data:application/json;base64,e30=')).toBe('data:application/json;base64,e30=');
      expect(maskUrl('not a url')).toBe('not a url');
    });
  });

  describe('maskJson', () => {
    it('masks Lambda environment maps wherever they appear', () => {
      const out = maskJson({
        FunctionName: 'fn',
        Environment: { Variables: { GH_TOKEN: 'gho_canarycanarycanarycanarycanary1234', ROWDY_DEBUG: 'true' } },
      });
      expect(out).toContain('"FunctionName":"fn"');
      expect(out).toContain('"GH_TOKEN":"gho_…1234 (38 chars)"');
      expect(out).toContain('"ROWDY_DEBUG":"… (4 chars)"');
      expect(out).not.toContain('canarycanary');
    });

    it('masks key-named strings, and leaves a bare Key and an access key id readable', () => {
      const out = JSON.parse(
        maskJson({
          API_KEY: 'sk-live-abcdef1234567890',
          apiKey: 'abcdef1234567890',
          privateKey: 'pem',
          Key: 'photos/1.png',
          accessKeyId: 'AKIDEXAMPLE',
        })
      );
      expect(out).toEqual({
        API_KEY: 'sk-…890 (24 chars)',
        apiKey: 'ab…90 (16 chars)',
        privateKey: '… (3 chars)',
        Key: 'photos/1.png',
        accessKeyId: 'AKIDEXAMPLE',
      });
    });

    it('masks every value of an env or environment map, whatever its name', () => {
      const out = JSON.parse(
        maskJson({ env: { NODE_ENV: 'production', ANYTHING: 'x' }, deep: { environment: { PORT: 8080 } } })
      );
      expect(out).toEqual({
        env: { NODE_ENV: 'p…n (10 chars)', ANYTHING: '… (1 chars)' },
        deep: { environment: { PORT: '… (4 chars)' } },
      });
    });

    it('masks credential-named strings and leaves the rest alone', () => {
      const out = maskJson({
        secrets: '{"A":"canary-secret-value-000000000000"}',
        authorizationData: [{ authorizationToken: 'QVdTOmNhbmFyeS10b2tlbi12YWx1ZQ==', proxyEndpoint: 'https://ecr' }],
        routes: './routes.yaml',
        nested: { SessionToken: 'canary-session-token-value-0000', Expiration: new Date(0) },
      });
      expect(out).not.toContain('canary-secret-value');
      expect(out).not.toContain('bmFyeS10b2tlbi12YWx1');
      expect(out).not.toContain('canary-session-token');
      // Under `authorizationData`, so masked with the token beside it.
      expect(out).not.toContain('"proxyEndpoint":"https://ecr"');
      expect(out).toContain('"routes":"./routes.yaml"');
      expect(out).toContain('"Expiration":"1970-01-01T00:00:00.000Z"');
    });

    it('names a value that leads back to itself instead of walking it again', () => {
      const looped: Record<string, unknown> = { name: 'a' };
      looped.self = looped;
      const shared = { id: 1 };

      expect(JSON.parse(maskJson({ looped, list: [shared, shared] }))).toEqual({
        looped: { name: 'a', self: '[Circular]' },
        list: [{ id: 1 }, { id: 1 }],
      });
    });

    it('names anything but arrays and plain objects by its class instead of walking it', () => {
      class Stream {
        socket: { stream?: Stream } = {};
        constructor() {
          this.socket.stream = this;
        }
      }

      expect(JSON.parse(maskJson({ Body: new Stream(), ContentLength: 2, bare: Object.create(null) }))).toEqual({
        Body: '[Stream]',
        ContentLength: 2,
        bare: {},
      });
    });

    it('masks every string under a credential-named key, whatever its own name', () => {
      const token = 'eyJraWQiOiJjYW5hcnkifQ.canary-token-body.cccc.dddd.eeee';
      const out = maskJson({
        authToken: { 'X-aws-proxy-auth': token },
        Credentials: { AccessKeyId: 'ASIACANARYCANARY0000', Expiration: new Date(0), list: ['canary-in-a-list-0000'] },
        endpoint: 'vm.example',
      });

      expect(out).not.toContain('canary');
      expect(out).toContain('"X-aws-proxy-auth":"eyJr…eeee (');
      expect(out).toContain('"Expiration":"1970-01-01T00:00:00.000Z"');
      expect(out).toContain('"endpoint":"vm.example"');
    });

    it('handles undefined and primitives', () => {
      expect(maskJson(undefined)).toBeUndefined();
      expect(maskJson('plain')).toBe('"plain"');
    });
  });
});

describe('Logger', () => {
  const ENV = ['ROWDY_LOG_LEVEL', 'ROWDY_LOG_FORMAT', 'ROWDY_DEBUG', 'ROWDY_TRACE'] as const;
  const saved: Record<string, string | undefined> = {};
  let lines: Array<{ sink: string; text: string }>;
  let spies: jest.SpyInstance[];
  const text = (): string[] => lines.map((line) => line.text);

  beforeEach(() => {
    for (const key of ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    new Logger().withLevel(undefined).withFormat(undefined).withSink(undefined);
    Logger.unbind('req', 'requestId', 'instance');
    lines = [];
    spies = (['debug', 'info', 'warn', 'error'] as const).map((sink) =>
      jest.spyOn(console, sink).mockImplementation((...args: unknown[]) => {
        lines.push({ sink, text: args.map(String).join(' ') });
      })
    );
  });

  afterEach(() => {
    spies.forEach((spy) => spy.mockRestore());
    new Logger().withLevel(undefined).withFormat(undefined).withSink(undefined);
    Logger.unbind('req', 'requestId', 'instance');
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('sink', () => {
    it('splits by level by default', () => {
      const log = new Logger().withLevel('debug');

      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');

      expect(lines.map(({ sink }) => sink)).toEqual(['debug', 'info', 'warn', 'error']);
    });

    it('sends every level to stderr when asked', () => {
      const log = new Logger().withLevel('trace').withSink('stderr');

      log.trace('t');
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');

      expect(lines.map(({ sink }) => sink)).toEqual(['error', 'error', 'error', 'error', 'error']);
    });

    it('sends relayed lines there too', () => {
      new Logger().withSink('stderr').relay('info', 'hello');

      expect(lines).toEqual([{ sink: 'error', text: 'INFO hello' }]);
    });

    it('sends JSON lines there too', () => {
      new Logger().withSink('stderr').withFormat('json').info('hello');

      expect(lines.map(({ sink }) => sink)).toEqual(['error']);
    });

    it('applies to every logger', () => {
      new Logger().withSink('stderr');

      new Logger('other').child('child').info('hello');

      expect(lines.map(({ sink }) => sink)).toEqual(['error']);
    });

    it('can go back', () => {
      new Logger().withSink('stderr').withSink(undefined).info('hello');

      expect(lines.map(({ sink }) => sink)).toEqual(['info']);
    });
  });

  describe('level', () => {
    it('defaults to info: debug and trace are silent', () => {
      const log = new Logger();
      log.error('e');
      log.warn('w');
      log.info('i');
      log.debug('d');
      log.trace('t');
      expect(text()).toEqual(['ERROR E', 'WARN W', 'INFO I']);
    });

    it('follows ROWDY_LOG_LEVEL, case-insensitively', () => {
      process.env.ROWDY_LOG_LEVEL = 'WARN';
      const log = new Logger();
      log.info('i');
      log.warn('w');
      expect(text()).toEqual(['WARN W']);
      expect(log.level).toBe('warn');
    });

    it('keeps ROWDY_DEBUG and ROWDY_TRACE as aliases', () => {
      process.env.ROWDY_DEBUG = 'true';
      expect(new Logger().level).toBe('debug');
      process.env.ROWDY_TRACE = 'true';
      expect(new Logger().level).toBe('trace');
    });

    it('lets an explicit ROWDY_LOG_LEVEL override stale legacy flags', () => {
      process.env.ROWDY_DEBUG = 'true';
      process.env.ROWDY_TRACE = 'true';
      process.env.ROWDY_LOG_LEVEL = 'info';
      const log = new Logger();
      log.debug('d');
      expect(text()).toEqual([]);
      expect(log.isDebugging).toBe(false);
    });

    it('ignores an unknown level instead of failing', () => {
      process.env.ROWDY_LOG_LEVEL = 'chatty';
      expect(new Logger().level).toBe('info');
    });

    it('is shared by every logger, children included', () => {
      const child = new Logger().child('vfs');
      new Logger().withLevel('debug');
      child.debug('d');
      expect(text()).toEqual(['DEBUG Vfs D']);
    });
  });

  describe('text format', () => {
    it('follows the platform lines: level, component, message, then Key: value pairs, no timestamp', () => {
      new Logger().child('vfs').info('flushed', { key: 'db/nuss.sqlite', size: 12288, ok: true });
      expect(text()).toEqual(['INFO Vfs Flushed Key: db/nuss.sqlite Size: 12288 Ok: true']);
    });

    it('title-cases plain-word messages and leaves identifiers and punctuation alone', () => {
      const log = new Logger();
      log.info('gRPC server starting', { port: 7939 });
      log.info('URI is healthy');
      log.info('mirror.gcr.io/library/alpine: Pulling from library/alpine');
      log.info('m', { responseBytes: 12, empty: '', duration: '4.20 ms' });
      expect(text()).toEqual([
        'INFO gRPC Server Starting Port: 7939',
        'INFO URI Is Healthy',
        'INFO mirror.gcr.io/library/alpine: Pulling from library/alpine',
        'INFO M ResponseBytes: 12 Empty: "" Duration: 4.20 ms',
      ]);
    });

    it('keeps one event per line', () => {
      new Logger().warn('first\nsecond', { error: new Error('boom') });
      expect(text()).toHaveLength(1);
      expect(text()[0]).not.toContain('\n');
      expect(text()[0]).toBe('WARN first \\n second Error: boom');
    });

    it('logs an error as name and message, with its stack only at debug and above', () => {
      const log = new Logger();
      log.warn('upstream error', { error: new Error('read ECONNRESET') });
      expect(text()).toEqual(['WARN Upstream Error Error: read ECONNRESET']);
      log.warn('upstream error', { error: new TypeError('bad input') });
      expect(text()[1]).toBe('WARN Upstream Error Error: TypeError: bad input');
      log.withLevel('debug');
      log.warn('upstream error', { error: new Error('read ECONNRESET') });
      expect(text()[2]).toContain('WARN Upstream Error Error: Error: read ECONNRESET \\n at ');
    });

    it('sends warn and error to stderr sinks and the rest to stdout sinks', () => {
      new Logger().withLevel('trace');
      const log = new Logger();
      log.error('e');
      log.warn('w');
      log.info('i');
      log.debug('d');
      log.trace('t');
      expect(lines.map((line) => line.sink)).toEqual(['error', 'warn', 'info', 'debug', 'debug']);
      expect(text()[4]).toBe('TRACE T');
    });
  });

  it('leads every line with the bound RequestId, like START / END / REPORT, until unbound', () => {
    const id = '4a43db8d-4950-44f7-b92a-eb1cef487d8b';
    const log = new Logger();
    Logger.bind({ requestId: id });
    log.info('Request', { method: 'POST', path: '/api/db' });
    log.child('vfs').debug('hidden at info');
    log.child('http').warn('upstream error', { status: 502 });
    Logger.unbind('requestId');
    log.info('Rowdy Started', { version: '0.1.0' });
    expect(text()).toEqual([
      `INFO RequestId: ${id} Request Method: POST Path: /api/db`,
      `WARN RequestId: ${id} Http Upstream Error Status: 502`,
      'INFO Rowdy Started Version: 0.1.0',
    ]);
  });

  it('appends other bound context as ordinary fields', () => {
    Logger.bind({ instance: 'i-1' });
    new Logger().info('ready');
    Logger.unbind('instance');
    expect(text()).toEqual(['INFO Ready Instance: i-1']);
  });

  it('emits one JSON object per line when ROWDY_LOG_FORMAT=json', () => {
    process.env.ROWDY_LOG_FORMAT = 'json';
    Logger.bind({ requestId: '575b7bbe' });
    new Logger().child('vfs').warn('lock failed', { path: '/s3/db', errno: 11 });
    expect(JSON.parse(text()[0]!)).toEqual({
      level: 'warn',
      component: 'vfs',
      msg: 'lock failed',
      path: '/s3/db',
      errno: 11,
      requestId: '575b7bbe',
    });
  });

  describe('relay', () => {
    it("passes a line of the command's output through as written, in the same shape", () => {
      const id = '4a43db8d-4950-44f7-b92a-eb1cef487d8b';
      const log = new Logger();
      log.child('stdout').relay('info', '▲ Next.js 16.2.4');
      Logger.bind({ requestId: id });
      log.child('stdout').relay('info', 'sqlite ready at /s3/db/nuss.sqlite  ');
      log.child('stderr').relay('error', '(node:13) ExperimentalWarning: SQLite is an experimental feature');
      expect(lines).toEqual([
        { sink: 'info', text: 'INFO Stdout ▲ Next.js 16.2.4' },
        { sink: 'info', text: `INFO RequestId: ${id} Stdout sqlite ready at /s3/db/nuss.sqlite` },
        {
          sink: 'error',
          text: `INFO RequestId: ${id} Stderr (node:13) ExperimentalWarning: SQLite is an experimental feature`,
        },
      ]);
    });

    it('is not filtered by level, drops blank lines and leaves JSON lines untouched', () => {
      const log = new Logger().withLevel('error').child('stdout');
      log.relay('info', 'still here');
      log.relay('info', '   ');
      log.relay('info', '{"level":"info","msg":"from the app"}');
      expect(text()).toEqual(['INFO Stdout still here', '{"level":"info","msg":"from the app"}']);
    });

    it('wraps the line as an object in the json format', () => {
      process.env.ROWDY_LOG_FORMAT = 'json';
      new Logger().child('stderr').relay('error', 'boom');
      expect(JSON.parse(text()[0]!)).toEqual({ level: 'info', component: 'stderr', msg: 'boom' });
    });
  });

  it('returns the same child for the same component', () => {
    const log = new Logger();
    expect(log.child('vfs')).toBe(log.child('vfs'));
    expect(log.child('vfs').component).toBe('vfs');
  });

  describe('@Trace', () => {
    // Its trace lines, without the span and metric wiretaps.
    const only = (lines: string[]): string[] =>
      lines.filter((line) => !/\b(Span Started|Span Ended|Metric Recorded)\b/.test(line));
    class Arg implements ILoggable {
      constructor(private readonly n: number) {}
      repr(): string {
        return `Arg(${this.n})`;
      }
    }
    class Thing {
      @Trace
      into(arg: Arg): Observable<string> {
        return of(`got ${arg.repr()}`);
      }

      @Trace
      fail(): Observable<string> {
        return throwError(() => new Error('boom'));
      }

      @Trace
      slow(): Observable<string> {
        return NEVER;
      }

      @Trace
      fast(): Observable<string> {
        return timer(1).pipe(map(() => 'fast'));
      }

      @Trace
      unloggable(): Observable<string> {
        return of({} as unknown as string);
      }
    }
    const duration = expect.stringMatching(/^\d+\.\d\d ms$/);

    it('is silent below trace', () => {
      new Logger().withLevel('debug');
      expect(new Thing().into(new Arg(1)).subscribe()).toBeDefined();
      expect(only(text())).toEqual([]);
    });

    it('logs the call, each emission and the completion, with the component and the duration', (done) => {
      new Logger().withLevel('trace');
      new Thing().into(new Arg(1)).subscribe({
        complete: () => {
          expect(only(text())).toEqual([
            'TRACE @scaffoldly/rowdy-cdk Thing.into Called Args: [Arg(1)]',
            expect.stringMatching(
              /^TRACE @scaffoldly\/rowdy-cdk Thing.into Emitted Duration: \d+\.\d\d ms Value: got Arg\(1\)$/
            ),
            expect.stringMatching(
              /^TRACE @scaffoldly\/rowdy-cdk Thing.into Completed Duration: \d+\.\d\d ms Emissions: 1$/
            ),
          ]);
          done();
        },
      });
    });

    it('logs a failure with the error', (done) => {
      new Logger().withLevel('trace');
      new Thing().fail().subscribe({
        error: () => {
          expect(only(text())[0]).toBe('TRACE @scaffoldly/rowdy-cdk Thing.fail Called');
          expect(only(text())[1]).toMatch(
            /^TRACE @scaffoldly\/rowdy-cdk Thing.fail Failed Duration: \d+\.\d\d ms Emissions: 0 Error: Error: boom/
          );
          expect(only(text())).toHaveLength(2);
          done();
        },
      });
    });

    it('logs the loser of a race as unsubscribed', (done) => {
      new Logger().withLevel('trace');
      const thing = new Thing();
      race([thing.slow(), thing.fast()]).subscribe({
        complete: () => {
          expect(only(text())).toEqual([
            'TRACE @scaffoldly/rowdy-cdk Thing.slow Called',
            'TRACE @scaffoldly/rowdy-cdk Thing.fast Called',
            expect.stringMatching(/^TRACE @scaffoldly\/rowdy-cdk Thing.fast Emitted Duration: .* Value: fast$/),
            expect.stringMatching(/^TRACE @scaffoldly\/rowdy-cdk Thing.slow Unsubscribed Duration: .* Emissions: 0$/),
            expect.stringMatching(/^TRACE @scaffoldly\/rowdy-cdk Thing.fast Completed Duration: .* Emissions: 1$/),
          ]);
          done();
        },
      });
    });

    it('is JSON like any other line', (done) => {
      new Logger().withLevel('trace').withFormat('json');
      new Thing().into(new Arg(2)).subscribe({
        complete: () => {
          expect(JSON.parse(only(text())[1]!)).toEqual({
            level: 'trace',
            component: '@scaffoldly/rowdy-cdk',
            msg: 'Thing.into Emitted',
            duration,
            value: 'got Arg(2)',
          });
          done();
        },
      });
    });

    describe('spans', () => {
      const exporter = new InMemorySpanExporter();
      const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

      class Bar {
        constructor(readonly secret: string) {}
      }

      const RUN = Symbol('run');

      class Pending implements PromiseLike<string> {
        constructor(private readonly settled: Promise<string>) {}
        extra(): string {
          return 'extra';
        }
        then<A = string, B = never>(
          ok?: ((value: string) => A | PromiseLike<A>) | null,
          err?: ((reason: unknown) => B | PromiseLike<B>) | null
        ): Promise<A | B> {
          return this.settled.then(ok, err);
        }
      }

      class Traced {
        @Trace
        pending(fail: boolean): Pending {
          return new Pending(fail ? Promise.reject(new Error('pending failed')) : Promise.resolve('done'));
        }

        @Trace
        [RUN](): number {
          return 1;
        }

        @Trace
        static async create(): Promise<Traced> {
          await Promise.resolve();
          return new Traced();
        }

        @Trace
        async doWork(bar: Bar): Promise<Bar> {
          trace.getTracer('test').startSpan('before await').end();
          await new Promise((resolve) => setTimeout(resolve, 1));
          trace.getTracer('test').startSpan('after await').end();
          return bar;
        }

        @Trace
        async reject(): Promise<never> {
          throw new RangeError('nope');
        }

        @Trace
        doSyncWork(n: number): number {
          trace.getTracer('test').startSpan('sync child').end();
          return n * 2;
        }

        @Trace
        throwSync(): number {
          throw new Error('sync boom');
        }

        attempts = 0;

        @Trace
        flaky(): Observable<string> {
          return defer(() => {
            this.attempts += 1;
            return this.attempts < 3 ? throwError(() => new Error(`attempt ${this.attempts}`)) : of('ok');
          });
        }

        @Trace
        child(): Observable<string> {
          return defer(() => {
            trace.getTracer('test').startSpan('child').end();
            return of('child');
          });
        }

        @Trace
        twice(): Observable<number> {
          return of(1, 2);
        }
      }

      const finished = (): Array<{
        name: string;
        kind: SpanKind;
        status: SpanStatusCode;
        attributes: Record<string, unknown>;
        events: string[];
        parent?: string;
        id: string;
        ms: number;
      }> =>
        exporter.getFinishedSpans().map((s) => ({
          name: s.name,
          kind: s.kind,
          status: s.status.code,
          attributes: { ...s.attributes },
          events: s.events.map((e) => e.name),
          parent: s.parentSpanContext?.spanId,
          id: s.spanContext().spanId,
          ms: s.duration[0] * 1e3 + s.duration[1] / 1e6,
        }));

      beforeAll(() => {
        context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
        // The test's own spans come from the global provider; @Trace's, from CdkInstrumentation's.
        trace.setGlobalTracerProvider(provider);
        CdkInstrumentation.create({ tracerProvider: provider });
      });

      afterAll(async () => {
        await provider.shutdown();
        trace.disable();
        context.disable();
      });

      beforeEach(() => {
        exporter.reset();
        new Logger().withLevel('debug');
        // Options are merged into the one CdkInstrumentation: each test starts from the test provider only.
        const cdk = CdkInstrumentation as unknown as { instance?: CdkInstrumentation };
        cdk.instance?.disable();
        cdk.instance = undefined;
        CdkInstrumentation.create({ tracerProvider: provider });
      });

      it('makes one span per subscription, named for the method, below trace too', (done) => {
        new Thing().into(new Arg(1)).subscribe({
          complete: () => {
            expect(finished()).toEqual([
              expect.objectContaining({
                name: 'Thing.into',
                kind: SpanKind.INTERNAL,
                status: SpanStatusCode.UNSET,
                attributes: {
                  'code.function.name': 'Thing.into',
                  'cdk.trace.outcome': 'complete',
                  'cdk.observable.emissions': 1,
                },
                events: [],
              }),
            ]);
            done();
          },
        });
      });

      it('counts every emission', (done) => {
        new Traced().twice().subscribe({
          complete: () => {
            expect(finished()[0]!.attributes['cdk.observable.emissions']).toBe(2);
            done();
          },
        });
      });

      it('records the error and sets the status on failure', (done) => {
        new Thing().fail().subscribe({
          error: () => {
            expect(finished()).toEqual([
              expect.objectContaining({
                name: 'Thing.fail',
                status: SpanStatusCode.ERROR,
                attributes: {
                  'code.function.name': 'Thing.fail',
                  'cdk.trace.outcome': 'error',
                  'cdk.observable.emissions': 0,
                  'error.type': 'Error',
                },
                events: ['exception'],
              }),
            ]);
            done();
          },
        });
      });

      it('logs an emission that is a plain object as masked JSON', (done) => {
        new Logger().withLevel('trace');
        new Thing().unloggable().subscribe({
          complete: () => {
            expect(only(text())[1]).toMatch(
              /^TRACE @scaffoldly\/rowdy-cdk Thing.unloggable Emitted Duration: \d+\.\d\d ms Value: \{\}$/
            );
            expect(finished()[0]!.attributes['cdk.trace.outcome']).toBe('complete');
            done();
          },
        });
      });

      it('ends the loser of a race as unsubscribed, without an error', (done) => {
        const thing = new Thing();
        race([thing.slow(), thing.fast()]).subscribe({
          complete: () => {
            const slow = finished().find((s) => s.name === 'Thing.slow');
            expect(slow).toEqual(
              expect.objectContaining({
                status: SpanStatusCode.UNSET,
                attributes: expect.objectContaining({ 'cdk.trace.outcome': 'unsubscribe' }),
              })
            );
            done();
          },
        });
      });

      it('parents spans made while subscribing on the method span', (done) => {
        new Traced().child().subscribe({
          complete: () => {
            const spans = finished();
            const method = spans.find((s) => s.name === 'Traced.child')!;
            expect(spans.find((s) => s.name === 'child')!.parent).toBe(method.id);
            done();
          },
        });
      });

      it('parents the method span on the span active at subscribe', (done) => {
        const outer = trace.getTracer('test').startSpan('outer');
        context.with(trace.setSpan(context.active(), outer), () =>
          new Thing().into(new Arg(1)).subscribe({
            complete: () => {
              outer.end();
              expect(finished().find((s) => s.name === 'Thing.into')!.parent).toBe(outer.spanContext().spanId);
              done();
            },
          })
        );
      });

      it('ends an async method span when its Promise resolves, parenting spans on both sides of an await', async () => {
        const bar = new Bar('hunter2');
        await expect(new Traced().doWork(bar)).resolves.toBe(bar);
        const spans = finished();
        const method = spans.find((s) => s.name === 'Traced.doWork')!;
        expect(method).toEqual(
          expect.objectContaining({
            status: SpanStatusCode.UNSET,
            attributes: { 'code.function.name': 'Traced.doWork', 'cdk.trace.outcome': 'complete' },
          })
        );
        expect(spans.find((s) => s.name === 'before await')!.parent).toBe(method.id);
        expect(spans.find((s) => s.name === 'after await')!.parent).toBe(method.id);
      });

      it('records a rejected Promise on the span and still rejects', async () => {
        await expect(new Traced().reject()).rejects.toThrow('nope');
        expect(finished()).toEqual([
          expect.objectContaining({
            name: 'Traced.reject',
            status: SpanStatusCode.ERROR,
            attributes: expect.objectContaining({ 'cdk.trace.outcome': 'error', 'error.type': 'RangeError' }),
            events: ['exception'],
          }),
        ]);
      });

      it('names a static method for its class, with the bare decorator', async () => {
        await expect(Traced.create()).resolves.toBeInstanceOf(Traced);
        expect(finished().map((s) => s.name)).toEqual(['Traced.create']);
      });

      it('ends a sync method span with the call, parenting spans made in it', () => {
        expect(new Traced().doSyncWork(2)).toBe(4);
        const spans = finished();
        const method = spans.find((s) => s.name === 'Traced.doSyncWork')!;
        expect(method.attributes['cdk.trace.outcome']).toBe('complete');
        expect(spans.find((s) => s.name === 'sync child')!.parent).toBe(method.id);
      });

      it('records a sync throw on the span and rethrows it', () => {
        expect(() => new Traced().throwSync()).toThrow('sync boom');
        expect(finished()).toEqual([
          expect.objectContaining({
            name: 'Traced.throwSync',
            status: SpanStatusCode.ERROR,
            attributes: expect.objectContaining({ 'cdk.trace.outcome': 'error', 'error.type': 'Error' }),
          }),
        ]);
      });

      it('returns a promise-like as it is, methods and all, and ends the span when it settles', async () => {
        const pending = new Traced().pending(false);
        expect(pending).toBeInstanceOf(Pending);
        expect(pending.extra()).toBe('extra');
        await expect(pending).resolves.toBe('done');
        await new Promise((resolve) => setImmediate(resolve));
        expect(finished()).toEqual([
          expect.objectContaining({
            name: 'Traced.pending',
            attributes: expect.objectContaining({ 'cdk.trace.outcome': 'complete' }),
          }),
        ]);
      });

      it('still rejects a promise-like that fails, without an unhandled rejection of its own', async () => {
        const unhandled: unknown[] = [];
        const listener = (reason: unknown): void => void unhandled.push(reason);
        process.on('unhandledRejection', listener);
        try {
          await expect(new Traced().pending(true)).rejects.toThrow('pending failed');
          await new Promise((resolve) => setImmediate(resolve));
          expect(finished()).toEqual([
            expect.objectContaining({
              name: 'Traced.pending',
              status: SpanStatusCode.ERROR,
              attributes: expect.objectContaining({ 'cdk.trace.outcome': 'error' }),
            }),
          ]);
          expect(unhandled).toEqual([]);
        } finally {
          process.off('unhandledRejection', listener);
        }
      });

      it('adds no unhandled rejection to a failed async call that is awaited', async () => {
        const unhandled: unknown[] = [];
        const listener = (reason: unknown): void => void unhandled.push(reason);
        process.on('unhandledRejection', listener);
        try {
          await expect(new Traced().reject()).rejects.toThrow('nope');
          await new Promise((resolve) => setTimeout(resolve, 10));
          expect(unhandled).toEqual([]);
        } finally {
          process.off('unhandledRejection', listener);
        }
      });

      it('names a symbol method by its description', () => {
        expect(new Traced()[RUN]()).toBe(1);
        expect(finished().map((s) => s.name)).toEqual(['Traced.[run]']);
      });

      describe('with options of each call', () => {
        interface Options extends CdkOptions {
          name?: string;
        }

        const recorded: string[] = [];
        const sink = { write: (line: string): number => recorded.push(line.trimEnd()) };
        // Records into one of our Loggers, so they read as its lines.
        const linesAt = (level: Level): LoggerProvider => ({ getLogger: () => new Logger(undefined, sink, level) });

        class Factory {
          constructor(readonly options?: Options) {}

          @Trace((lookup: Options) => lookup)
          static async get(lookup: Options): Promise<Factory> {
            return new Factory(lookup);
          }

          @Trace((options?: Options) => options)
          static create(options?: Options): Factory {
            return new Factory(options);
          }

          @Trace(function (this: Factory, _cmd: string) {
            return this.options;
          })
          async run(cmd: string): Promise<string> {
            return `ran ${cmd}`;
          }
        }

        beforeEach(() => {
          recorded.length = 0;
          // The process-wide log traces too, so a line written there would show.
          new Logger().withLevel('trace');
        });

        it('logs on the loggerProvider of a static call with a required argument, at its level', async () => {
          await Factory.get({ name: 'box', loggerProvider: linesAt('trace') });
          expect(only(recorded)).toEqual([
            'TRACE Factory.get Called Args: [{"name":"box","loggerProvider":{}}]',
            expect.stringMatching(/^TRACE Factory.get Completed Duration: \d+\.\d\d ms Value: Factory$/),
          ]);
          expect(only(text())).toEqual([]);
          expect(finished().map((s) => s.name)).toEqual(['Factory.get']);
        });

        it('logs on the loggerProvider of a static call with an optional argument', () => {
          Factory.create({ loggerProvider: linesAt('trace') });
          expect(only(recorded)).toEqual([
            'TRACE Factory.create Called Args: [{"loggerProvider":{}}]',
            expect.stringMatching(/^TRACE Factory.create Completed Duration: .* Value: Factory$/),
          ]);
          expect(only(text())).toEqual([]);
        });

        it('logs as Logger.defaults() would without a loggerProvider, or without options', () => {
          Factory.create();
          Factory.create({ name: 'box' });
          expect(only(recorded)).toEqual([]);
          expect(only(text())).toEqual([
            'TRACE @scaffoldly/rowdy-cdk Factory.create Called',
            expect.stringMatching(
              /^TRACE @scaffoldly\/rowdy-cdk Factory.create Completed Duration: .* Value: Factory$/
            ),
            'TRACE @scaffoldly/rowdy-cdk Factory.create Called Args: [{"name":"box"}]',
            expect.stringMatching(
              /^TRACE @scaffoldly\/rowdy-cdk Factory.create Completed Duration: .* Value: Factory$/
            ),
          ]);
          expect(finished().map((s) => s.name)).toEqual(['Factory.create', 'Factory.create']);
        });

        it('logs nothing below its own level', () => {
          Factory.create({ loggerProvider: linesAt('debug') });
          expect(only(recorded)).toEqual([]);
          expect(only(text())).toEqual([]);
          expect(finished()).toHaveLength(1);
        });

        it('records each run on the meterProvider in its options', async () => {
          const recorded: Array<[number, unknown]> = [];
          const histogram = {
            record: (value: number, attributes: unknown): number => recorded.push([value, attributes]),
          };
          const meter = { createHistogram: jest.fn(() => histogram) };
          const meterProvider = { getMeter: jest.fn(() => meter) } as unknown as MeterProvider;
          await Factory.get({ meterProvider });
          expect(meter.createHistogram).toHaveBeenCalledWith(
            'cdk.trace.duration',
            expect.objectContaining({ unit: 's' })
          );
          expect(recorded).toEqual([
            [expect.any(Number), { 'code.function.name': 'Factory.get', 'cdk.trace.outcome': 'complete' }],
          ]);
        });

        it("emits each trace line on the loggerProvider in its options, in its span, at the call's logLevel", async () => {
          const records: LogRecord[] = [];
          const otelLogger = {
            emit: (record: LogRecord): number => records.push(record),
            enabled: (): boolean => true,
          };
          const loggerProvider = { getLogger: jest.fn(() => otelLogger) } as unknown as LoggerProvider;
          new Logger().withLevel('info');
          await Factory.get({ loggerProvider, logLevel: 'trace' });
          const span = finished().find((s) => s.name === 'Factory.get')!;
          // Its trace lines; the span and metric wiretaps are checked on their own.
          records.splice(
            0,
            records.length,
            ...records.filter(
              (r) => r.severityNumber === SeverityNumber.TRACE && !/^(Span|Metric) /.test(String(r.body))
            )
          );
          expect(records.map((r) => [r.severityNumber, r.body])).toEqual([
            [SeverityNumber.TRACE, 'Factory.get Called'],
            [SeverityNumber.TRACE, 'Factory.get Completed'],
          ]);
          expect(records[0]!.attributes).toEqual({ args: '[{"loggerProvider":{},"logLevel":"trace"}]' });
          expect(records[1]!.attributes).toEqual({ duration: expect.stringMatching(/ ms$/), value: 'Factory' });
          expect(records.map((r) => trace.getSpan(r.context!)?.spanContext().spanId)).toEqual([span.id, span.id]);
          expect(only(text())).toEqual([]);
        });

        it('emits nothing on a loggerProvider whose logger is not enabled for it', async () => {
          const otelLogger = { emit: jest.fn(), enabled: (): boolean => false };
          const loggerProvider = { getLogger: () => otelLogger } as unknown as LoggerProvider;
          await Factory.get({ loggerProvider });
          expect(otelLogger.emit).not.toHaveBeenCalled();
        });

        it("logs where the process-wide log does at a call's logLevel, over the process-wide one", () => {
          new Logger().withLevel('info');
          Factory.create({ logLevel: 'trace' });
          expect(only(text())).toEqual([
            'TRACE @scaffoldly/rowdy-cdk Factory.create Called Args: [{"logLevel":"trace"}]',
            expect.stringMatching(
              /^TRACE @scaffoldly\/rowdy-cdk Factory.create Completed Duration: .* Value: Factory$/
            ),
          ]);
        });

        it("logs nothing when a call's logLevel is below trace, whatever the process-wide one", () => {
          Factory.create({ logLevel: 'debug' });
          expect(only(text())).toEqual([]);
          expect(finished()).toHaveLength(1);
        });

        it("emits records on a loggerProvider only when the call's logLevel, or else the process-wide one, is trace", () => {
          Factory.create({ loggerProvider: linesAt('trace'), logLevel: 'info' });
          expect(only(recorded)).toEqual([]);
          Factory.create({ loggerProvider: linesAt('trace'), logLevel: 'trace' });
          expect(only(recorded)).toHaveLength(2);
          expect(only(text())).toEqual([]);
        });

        it('logs through the process-wide log with Logger.defaults(), under its logger name', () => {
          Factory.create({ ...Logger.defaults() });
          expect(only(text())).toEqual([
            'TRACE @scaffoldly/rowdy-cdk Factory.create Called Args: [{"loggerProvider":{},"logLevel":"trace"}]',
            expect.stringMatching(
              /^TRACE @scaffoldly\/rowdy-cdk Factory.create Completed Duration: .* Value: Factory$/
            ),
          ]);
          new Logger().withLevel('info');
          Factory.create({ ...Logger.defaults() });
          expect(only(text())).toHaveLength(2);
        });

        it('shows an object argument as masked JSON, and an instance by its class only', () => {
          class Credentials {
            secretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
          }
          Factory.create({
            loggerProvider: linesAt('trace'),
            name: 'box',
            env: { API_KEY: 'sk-live-abcdef1234567890' },
            credentials: new Credentials(),
          } as Options);
          expect(only(recorded)[0]).toBe(
            'TRACE Factory.create Called Args: [{"loggerProvider":{},"name":"box","env":{"API_KEY":"sk-…890 (24 chars)"},"credentials":"[Credentials]"}]'
          );
        });

        it('caps an object argument at 1024 characters', () => {
          Factory.create({ loggerProvider: linesAt('trace'), name: 'x'.repeat(5000) } as Options);
          expect(only(recorded)[0]).toMatch(
            /^TRACE Factory.create Called Args: \[\{"loggerProvider":\{\},"name":"x+… \(\d+ chars\)\]$/
          );
          expect(only(recorded)[0]!.length).toBeLessThan(1200);
        });

        it('names its lines and span after the name and version CdkInstrumentation was given, not a call', () => {
          CdkInstrumentation.create({ name: '@scaffoldly/rowdy', version: '1.2.3' });
          Factory.create({ name: 'box' } as Options);
          expect(only(text())[0]).toBe('TRACE @scaffoldly/rowdy Factory.create Called Args: [{"name":"box"}]');
          const [span] = exporter.getFinishedSpans();
          expect([span!.instrumentationScope.name, span!.instrumentationScope.version]).toEqual([
            '@scaffoldly/rowdy',
            '1.2.3',
          ]);
        });

        describe('wiretaps', () => {
          const ID = '[0-9a-f]{32}';
          const SPAN = '[0-9a-f]{16}';

          it('logs each span as it ends at info', () => {
            Factory.create({ loggerProvider: linesAt('info') });
            expect(recorded).toEqual([
              expect.stringMatching(
                new RegExp(
                  `^INFO Span Ended Name: Factory.create Duration: \\d+\\.\\d\\d ms Outcome: complete TraceId: ${ID} SpanId: ${SPAN}$`
                )
              ),
            ]);
          });

          it('also logs each span as it starts at debug, with its attributes', () => {
            Factory.create({ loggerProvider: linesAt('debug') });
            expect(recorded).toEqual([
              expect.stringMatching(
                new RegExp(
                  `^DEBUG Span Started Name: Factory.create TraceId: ${ID} SpanId: ${SPAN} Code.function.name: Factory.create$`
                )
              ),
              expect.stringMatching(/^INFO Span Ended Name: Factory.create /),
            ]);
          });

          it('also logs its trace lines and every metric value at trace', () => {
            Factory.create({ loggerProvider: linesAt('trace') });
            expect(recorded.map((line) => line.split(' ').slice(0, 3).join(' '))).toEqual([
              'DEBUG Span Started',
              'TRACE Factory.create Called',
              'TRACE Factory.create Completed',
              'INFO Span Ended',
              'TRACE Metric Recorded',
            ]);
            expect(recorded[4]).toMatch(
              /^TRACE Metric Recorded Name: cdk.trace.duration Value: [\d.e-]+ s Code.function.name: Factory.create Cdk.trace.outcome: complete$/
            );
          });

          it('gives a span that ended in error its error', async () => {
            class Failing {
              @Trace((options: Options) => options)
              static async fail(_options: Options): Promise<never> {
                throw new RangeError('nope');
              }
            }
            await expect(Failing.fail({ loggerProvider: linesAt('info') })).rejects.toThrow('nope');
            expect(recorded).toEqual([
              expect.stringMatching(
                /^INFO Span Ended Name: Failing.fail .* Outcome: error .* Exception: RangeError: nope$/
              ),
            ]);
          });

          it('leaves the ids out when there is no tracer provider to record the span', () => {
            const cdk = CdkInstrumentation as unknown as { instance?: CdkInstrumentation };
            cdk.instance?.disable();
            cdk.instance = undefined;
            Factory.create({ loggerProvider: linesAt('info') });
            expect(recorded).toEqual([
              expect.stringMatching(/^INFO Span Ended Name: Factory.create Duration: \d+\.\d\d ms Outcome: complete$/),
            ]);
          });
        });

        it("writes its lines to stderr with loggerProvider: 'stderr', at its logLevel", () => {
          new Logger().withLevel('info');
          Factory.create({ loggerProvider: 'stderr', logLevel: 'trace' });
          const errors = lines.filter((line) => line.sink === 'error').map((line) => line.text);
          expect(only(errors)).toEqual([
            'TRACE @scaffoldly/rowdy-cdk Factory.create Called Args: [{"loggerProvider":"stderr","logLevel":"trace"}]',
            expect.stringMatching(
              /^TRACE @scaffoldly\/rowdy-cdk Factory.create Completed Duration: .* Value: Factory$/
            ),
          ]);
          expect(errors).toContainEqual(
            expect.stringMatching(/^INFO @scaffoldly\/rowdy-cdk Span Ended Name: Factory.create /)
          );
          expect(lines.filter((line) => line.sink !== 'error')).toEqual([]);
        });

        it('writes nothing to stderr below its logLevel', () => {
          Factory.create({ loggerProvider: 'stderr', logLevel: 'warn' });
          expect(lines).toEqual([]);
        });

        it('traces through a loggerProvider whose loggers have only emit', () => {
          const emit = jest.fn();
          const loggerProvider = { getLogger: () => ({ emit }) } as unknown as LoggerProvider;
          expect(() => Factory.create({ loggerProvider, logLevel: 'trace' })).not.toThrow();
          expect(emit.mock.calls.map(([record]) => record.body)).toEqual(
            expect.arrayContaining(['Factory.create Called', 'Factory.create Completed', 'Span Ended'])
          );
        });

        it("sends a call's span to the tracerProvider in its options, not the global one", () => {
          const own = new InMemorySpanExporter();
          const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: own })] });
          Factory.create({ tracerProvider });
          expect(own.getFinishedSpans().map((s) => s.name)).toEqual(['Factory.create']);
          expect(finished()).toEqual([]);
        });

        it('takes options from an instance call, with its this', async () => {
          const factory = Factory.create({ loggerProvider: linesAt('trace') });
          recorded.length = 0;
          await expect(factory.run('ls')).resolves.toBe('ran ls');
          expect(only(recorded)).toEqual([
            'TRACE Factory.run Called Args: [ls]',
            expect.stringMatching(/^TRACE Factory.run Completed Duration: .* Value: ran ls$/),
          ]);
          expect(only(text())).toEqual([]);
        });
      });

      it('makes a span for each attempt of a retried Observable', (done) => {
        new Traced()
          .flaky()
          .pipe(retry(2))
          .subscribe({
            complete: () => {
              expect(finished().map((s) => s.attributes['cdk.trace.outcome'])).toEqual(['error', 'error', 'complete']);
              done();
            },
          });
      });

      it('logs sync and async calls, and values that are not Loggable by class name only', async () => {
        new Logger().withLevel('trace');
        const traced = new Traced();
        traced.doSyncWork(2);
        await traced.doWork(new Bar('hunter2'));
        expect(only(text())).toEqual([
          'TRACE @scaffoldly/rowdy-cdk Traced.doSyncWork Called Args: [2]',
          expect.stringMatching(
            /^TRACE @scaffoldly\/rowdy-cdk Traced.doSyncWork Completed Duration: \d+\.\d\d ms Value: 4$/
          ),
          'TRACE @scaffoldly/rowdy-cdk Traced.doWork Called Args: [Bar]',
          expect.stringMatching(
            /^TRACE @scaffoldly\/rowdy-cdk Traced.doWork Completed Duration: \d+\.\d\d ms Value: Bar$/
          ),
        ]);
        expect(only(text()).join('\n')).not.toContain('hunter2');
      });

      const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

      it('ends the call span at return for an Observable subscribed later, under the span active then', async () => {
        const built = new Traced().twice();
        await tick(20);
        const request = trace.getTracer('test').startSpan('request');
        await context.with(trace.setSpan(context.active(), request), () => lastValueFrom(built));
        request.end();

        const spans = finished().filter((s) => s.name === 'Traced.twice');
        expect(spans.map((s) => s.attributes['cdk.trace.outcome'])).toEqual(['returned', 'complete']);
        expect(spans[0]!.parent).toBeUndefined();
        expect(spans[0]!.ms).toBeLessThan(10);
        expect(spans[1]!.parent).toBe(request.spanContext().spanId);
        expect(spans[1]!.attributes['cdk.observable.emissions']).toBe(2);
      });

      it('ends the call span of an Observable never subscribed, and logs that it returned', async () => {
        new Logger().withLevel('trace');
        new Traced().twice();
        await tick();
        expect(finished()).toEqual([
          expect.objectContaining({
            name: 'Traced.twice',
            attributes: expect.objectContaining({ 'cdk.trace.outcome': 'returned' }),
          }),
        ]);
        expect(only(text())).toEqual([
          'TRACE @scaffoldly/rowdy-cdk Traced.twice Called',
          expect.stringMatching(/^TRACE @scaffoldly\/rowdy-cdk Traced.twice Returned Duration: \d+\.\d\d ms$/),
        ]);
      });

      it('gives a subscription under another span its own span, even straight after the call', async () => {
        const built = new Traced().twice();
        const other = trace.getTracer('test').startSpan('other');
        await context.with(trace.setSpan(context.active(), other), () => lastValueFrom(built));
        other.end();

        const spans = finished().filter((s) => s.name === 'Traced.twice');
        expect(spans.map((s) => s.attributes['cdk.trace.outcome'])).toEqual(['returned', 'complete']);
        expect(spans[1]!.parent).toBe(other.spanContext().spanId);
      });

      it('makes a span for each subscription to the same observable', (done) => {
        const once = new Traced().twice();
        once.subscribe();
        once.subscribe({
          complete: () => {
            expect(finished().filter((s) => s.name === 'Traced.twice')).toHaveLength(2);
            done();
          },
        });
      });
    });
  });
});

describe('Logger as a sink', () => {
  const lines: string[] = [];
  const stream = { write: (line: string): number => lines.push(line.trimEnd()) };

  beforeEach(() => {
    lines.length = 0;
  });

  it('takes the call, writing it under the logger that made it', () => {
    new Logger('outer', new Logger('inner', stream, 'trace'), 'trace').info('sandbox ready', { sandboxId: 'box' });
    expect(lines).toEqual(['INFO Outer Sandbox Ready SandboxId: box']);
  });

  it('applies both levels', () => {
    new Logger('outer', new Logger('inner', stream, 'trace'), 'warn').info('dropped by outer');
    new Logger('outer', new Logger('inner', stream, 'warn'), 'trace').info('dropped by inner');
    new Logger('outer', new Logger('inner', stream, 'warn'), 'trace').warn('kept');
    expect(lines).toEqual(['WARN Outer Kept']);
  });

  it('relays through it', () => {
    new Logger('outer', new Logger('inner', stream, 'trace')).relay('info', 'from the command');
    expect(lines).toEqual(['INFO Outer from the command']);
  });
});

describe('Logger.defaults', () => {
  afterEach(() => {
    new Logger().withLevel(undefined);
  });

  it('is a logger provider of the process-wide log, at the process-wide level', () => {
    new Logger().withLevel('debug');
    const defaults = Logger.defaults();
    expect(defaults.logLevel).toBe('debug');
    const sandbox = defaults.loggerProvider!.getLogger('sandbox');
    expect(sandbox).toBe(defaults.loggerProvider!.getLogger('sandbox'));
    expect(sandbox).toBe(log.child('sandbox'));
    expect(Logger.defaults().loggerProvider).toBe(defaults.loggerProvider);
  });

  it('filters a logger provider at a level, or live at the process-wide one', () => {
    const emit = jest.fn();
    const provider = { getLogger: (): OtelLogger => ({ emit, enabled: (): boolean => true }) };
    const warn = Logger.filter(provider, 'warn').getLogger('x');
    warn.emit({ severityNumber: SeverityNumber.INFO, body: 'dropped' });
    warn.emit({ severityNumber: SeverityNumber.ERROR, body: 'kept' });
    expect(emit.mock.calls.map(([record]) => record.body)).toEqual(['kept']);
    expect(warn.enabled({ severityNumber: SeverityNumber.INFO })).toBe(false);
    expect(warn.enabled({ severityNumber: SeverityNumber.WARN })).toBe(true);
    expect(Logger.filter(provider, 'warn')).toBe(Logger.filter(provider, 'warn'));

    const live = Logger.filter(provider).getLogger('x');
    new Logger().withLevel('info');
    expect(live.enabled({ severityNumber: SeverityNumber.DEBUG })).toBe(false);
    new Logger().withLevel('debug');
    expect(live.enabled({ severityNumber: SeverityNumber.DEBUG })).toBe(true);
  });

  it('filters a logger that has no enabled() of its own, as if it were always enabled', () => {
    const emit = jest.fn();
    const provider = { getLogger: (): OtelLogger => ({ emit }) as unknown as OtelLogger };
    const info = Logger.filter(provider, 'info').getLogger('x');
    expect(info.enabled({ severityNumber: SeverityNumber.INFO })).toBe(true);
    expect(info.enabled({ severityNumber: SeverityNumber.DEBUG })).toBe(false);
    info.emit({ severityNumber: SeverityNumber.INFO, body: 'kept' });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('gives a logger provider that writes to a sink, the same one for the same sink and level', () => {
    const provider = Logger.to('stderr', 'debug');
    expect(Logger.to('stderr', 'debug')).toBe(provider);
    const logger = provider.getLogger('sandbox') as Logger;
    expect(logger).toBe(provider.getLogger('sandbox'));
    expect(logger.level).toBe('debug');
    expect(logger.component).toBe('sandbox');
  });

  it('gives a logger provider at a level of its own, the same one for the same level', () => {
    const provider = Logger.at('trace');
    expect(Logger.at('trace')).toBe(provider);
    const logger = provider.getLogger('sandbox') as Logger;
    expect(logger).toBe(provider.getLogger('sandbox'));
    expect(logger.level).toBe('trace');
  });
});

describe('Logger as an OpenTelemetry Logger', () => {
  const lines: string[] = [];
  const sink = { write: (line: string): number => lines.push(line.trimEnd()) };

  beforeEach(() => {
    lines.length = 0;
  });

  it('is one', () => {
    const otel: OtelLogger = new Logger('otel', sink, 'trace');
    expect(typeof otel.emit).toBe('function');
  });

  it('writes a log record as a line, at the level its severity falls in', () => {
    const log = new Logger('otel', sink, 'trace');
    for (const [severityNumber, body] of [
      [SeverityNumber.TRACE, 'trace line'],
      [SeverityNumber.DEBUG3, 'debug line'],
      [SeverityNumber.INFO, 'info line'],
      [SeverityNumber.WARN4, 'warn line'],
      [SeverityNumber.ERROR2, 'error line'],
      [SeverityNumber.FATAL, 'fatal line'],
    ] as const) {
      log.emit({ severityNumber, body });
    }
    expect(lines).toEqual([
      'TRACE Otel Trace Line',
      'DEBUG Otel Debug Line',
      'INFO Otel Info Line',
      'WARN Otel Warn Line',
      'ERROR Otel Error Line',
      'ERROR Otel Fatal Line',
    ]);
  });

  it('writes its attributes and exception as fields', () => {
    new Logger('otel', sink, 'info').emit({
      severityNumber: SeverityNumber.WARN,
      body: 'request done',
      attributes: { status: 503, path: '/sandbox', retried: true },
      exception: new Error('boom'),
    });
    expect(lines).toEqual(['WARN Otel Request Done Status: 503 Path: /sandbox Retried: true Error: boom']);
  });

  it('logs an unspecified severity at info, and a body that is not a string as JSON', () => {
    const log = new Logger('otel', sink, 'info');
    log.emit({ body: { id: 1, tags: ['a'] } });
    log.emit({ eventName: 'sandbox.ready' });
    expect(lines).toEqual(['INFO Otel {"id":1,"tags":["a"]}', 'INFO Otel sandbox.ready']);
  });

  it('writes nothing below its level, and says so through enabled()', () => {
    const log = new Logger('otel', sink, 'info');
    log.emit({ severityNumber: SeverityNumber.DEBUG, body: 'hidden' });
    expect(lines).toEqual([]);
    expect(log.enabled({ severityNumber: SeverityNumber.DEBUG })).toBe(false);
    expect(log.enabled({ severityNumber: SeverityNumber.WARN })).toBe(true);
    expect(log.enabled()).toBe(true);
    expect(log.enabled('debug')).toBe(false);
    expect(log.enabled('error')).toBe(true);
  });
});

describe('Logger with an OpenTelemetry logger as its sink', () => {
  const otel = (
    enabled?: (options?: { severityNumber?: SeverityNumber }) => boolean
  ): {
    records: LogRecord[];
    emit(record: LogRecord): void;
    enabled?: (options?: { severityNumber?: SeverityNumber }) => boolean;
  } => {
    const records: LogRecord[] = [];
    return { records, emit: (record): number => records.push(record), ...(enabled ? { enabled } : {}) };
  };

  it('is a Sink', () => {
    const sink: Sink = otel();
    expect(new Logger('sandbox', sink)).toBeInstanceOf(Logger);
  });

  it('writes each line as a record: its severity, the message as the body, its component and fields as attributes', () => {
    const logger = otel();
    const log = new Logger('sandbox', logger, 'debug');
    log.info('Sandbox Ready', { sandboxId: 'box', bytes: 12 });
    log.warn('slow');
    log.debug('detail', { n: 1 });
    log.trace('dropped below its level');
    expect(logger.records).toEqual([
      {
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: 'Sandbox Ready',
        attributes: { component: 'sandbox', sandboxId: 'box', bytes: 12 },
      },
      { severityNumber: SeverityNumber.WARN, severityText: 'WARN', body: 'slow', attributes: { component: 'sandbox' } },
      {
        severityNumber: SeverityNumber.DEBUG,
        severityText: 'DEBUG',
        body: 'detail',
        attributes: { component: 'sandbox', n: 1 },
      },
    ]);
  });

  it('puts an error in the exception', () => {
    const logger = otel();
    const boom = new Error('boom');
    new Logger('sandbox', logger, 'info').error('Failed', { error: boom, sandboxId: 'box' });
    expect(logger.records).toEqual([
      {
        severityNumber: SeverityNumber.ERROR,
        severityText: 'ERROR',
        body: 'Failed',
        attributes: { component: 'sandbox', sandboxId: 'box' },
        exception: boom,
      },
    ]);
  });

  it('puts an error in the exception at debug too, where a line would show its stack', () => {
    const logger = otel();
    const boom = new Error('boom');
    new Logger('sandbox', logger, 'debug').error('Failed', { error: boom });
    expect(logger.records[0]!.exception).toBe(boom);
    expect(logger.records[0]!.attributes).toEqual({ component: 'sandbox' });
  });

  it('gives a child the same logger, under its own component', () => {
    const logger = otel();
    new Logger('sandbox', logger, 'info').child('lambda').info('Invoked');
    expect(logger.records.map((r) => [r.body, r.attributes?.component])).toEqual([['Invoked', 'lambda']]);
  });

  it('asks the logger too, when it says whether it is enabled', () => {
    const logger = otel((options) => (options?.severityNumber ?? 0) >= SeverityNumber.WARN);
    const log = new Logger('sandbox', logger, 'trace');
    log.info('asked and dropped');
    log.warn('kept');
    expect(logger.records.map((r) => r.body)).toEqual(['kept']);
  });

  it('relays a line as a record', () => {
    const logger = otel();
    new Logger('sandbox', logger, 'info').relay('error', 'from the command\n');
    expect(logger.records).toEqual([
      {
        severityNumber: SeverityNumber.ERROR,
        severityText: 'ERROR',
        body: 'from the command',
        attributes: { component: 'sandbox' },
      },
    ]);
  });
});

describe('Logger sinks', () => {
  const ENV = ['ROWDY_LOG_LEVEL', 'ROWDY_LOG_FORMAT', 'ROWDY_DEBUG', 'ROWDY_TRACE'] as const;
  const saved: Record<string, string | undefined> = {};
  let consoled: unknown[][];
  let spies: jest.SpyInstance[];

  beforeEach(() => {
    for (const key of ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    new Logger().withLevel('debug').withFormat(undefined).withSink(undefined);
    consoled = [];
    spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => void consoled.push(args))
    );
  });

  afterEach(() => {
    spies.forEach((spy) => spy.mockRestore());
    new Logger().withLevel(undefined).withFormat(undefined).withSink(undefined);
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  type Recorded = Record<'debug' | 'info' | 'warn' | 'error', (...args: unknown[]) => void>;
  const recorder = (): { sink: Recorded; calls: Array<[string, unknown[]]> } => {
    const calls: Array<[string, unknown[]]> = [];
    const sink: Recorded = {
      debug: (...args) => void calls.push(['debug', args]),
      info: (...args) => void calls.push(['info', args]),
      warn: (...args) => void calls.push(['warn', args]),
      error: (...args) => void calls.push(['error', args]),
    };
    return { sink, calls };
  };

  it("gives a console-like sink each level's method, fields first and the message second", () => {
    const { sink, calls } = recorder();
    const log = new Logger('sandbox', sink);

    log.info('Sandbox Ready', { sandboxId: 'box' });
    log.warn('Slow');
    log.trace('Hidden at debug');
    log.debug('Seen at debug', { n: 1 });

    expect(calls).toEqual([
      ['info', [{ component: 'sandbox', sandboxId: 'box' }, 'Sandbox Ready']],
      ['warn', [{ component: 'sandbox' }, 'Slow']],
      ['debug', [{ component: 'sandbox', n: 1 }, 'Seen at debug']],
    ]);
    expect(consoled).toEqual([]);
  });

  it('writes a stream sink one formatted line at a time', () => {
    const written: string[] = [];
    const log = new Logger('sandbox', { write: (line: string): number => written.push(line) });

    log.info('Sandbox Ready', { sandboxId: 'box' });

    expect(written).toEqual(['INFO Sandbox Sandbox Ready SandboxId: box\n']);
    expect(consoled).toEqual([]);
  });

  it("gives its children its sink, and keeps them from another logger's", () => {
    const first = recorder();
    const second = recorder();

    new Logger('a', first.sink).child('client').info('One');
    new Logger('b', second.sink).child('client').info('Two');
    new Logger().child('client').info('Three');

    expect(first.calls).toEqual([['info', [{ component: 'client' }, 'One']]]);
    expect(second.calls).toEqual([['info', [{ component: 'client' }, 'Two']]]);
    expect(consoled.map((args) => args.join(' '))).toEqual(['INFO Client Three']);
  });

  it("names a child for a string, a class, or an instance's class, never an instance's own name", () => {
    const { sink, calls } = recorder();
    const log = new Logger('root', sink);
    class MicrovmImage {
      readonly name = 'sandbox-bcdf2';
      static make(): Logger {
        return log.child(this);
      }
      logger(): Logger {
        return log.child(this);
      }
    }

    log.child('http').info('A');
    log.child(MicrovmImage).info('B');
    MicrovmImage.make().info('C');
    new MicrovmImage().logger().info('D');

    expect(calls.map(([, [fields]]) => (fields as { component: string }).component)).toEqual([
      'http',
      'MicrovmImage',
      'MicrovmImage',
      'MicrovmImage',
    ]);
  });

  it('logs at its own level, its children too, whatever the process-wide one', () => {
    const quiet = recorder();
    const loud = recorder();
    new Logger().withLevel('info');

    const a = new Logger('a', quiet.sink, 'warn');
    const b = new Logger('b', loud.sink, 'debug');
    a.info('Dropped');
    a.child('client').warn('Kept');
    b.child('client').debug('Kept too');
    new Logger().withLevel('error');
    b.info('Still kept');

    expect(quiet.calls.map(([, [, message]]) => message)).toEqual(['Kept']);
    expect(loud.calls.map(([, [, message]]) => message)).toEqual(['Kept too', 'Still kept']);
    expect(a.child('client').level).toBe('warn');
    expect(new Logger('c', quiet.sink).level).toBe('error');
  });

  it('relays a command line to its sink', () => {
    const { sink, calls } = recorder();

    new Logger('cmd', sink).relay('error', 'oops\n');

    expect(calls).toEqual([['error', [{ component: 'cmd' }, 'oops']]]);
  });

  it('keeps the process-wide sink for a logger without its own', () => {
    new Logger().withSink('stderr');

    new Logger('x').info('To stderr');

    expect(spies[3]).toHaveBeenCalledWith('INFO X To Stderr');
  });

  describe('pino', () => {
    const capture = (): { lines: Array<Record<string, unknown>>; destination: { write(line: string): void } } => {
      const lines: Array<Record<string, unknown>> = [];
      const destination = { write: (line: string): void => void lines.push(JSON.parse(line)) };
      return { lines, destination };
    };

    it('plugs in as a logger, its fields merged into its own JSON', () => {
      const { lines, destination } = capture();
      const log = new Logger('sandbox', pino({ level: 'debug', base: undefined, timestamp: false }, destination));

      log.info('Sandbox Ready', { sandboxId: 'box', error: new Error('nope') });
      log.debug('Polling');

      expect(lines).toEqual([
        // At debug an error carries its stack, as it does for any sink.
        {
          level: 30,
          component: 'sandbox',
          sandboxId: 'box',
          error: expect.stringMatching(/^Error: nope\n/),
          msg: 'Sandbox Ready',
        },
        { level: 20, component: 'sandbox', msg: 'Polling' },
      ]);
    });

    it("plugs in as a stream, through pino's destination", () => {
      const written: string[] = [];
      const destination = pino.destination({ dest: 2, sync: true });
      const write = jest.spyOn(destination, 'write').mockImplementation((line: string) => {
        written.push(line);
        return true;
      });

      new Logger('sandbox', destination).info('Sandbox Ready');

      expect(write).toHaveBeenCalled();
      expect(written).toEqual(['INFO Sandbox Sandbox Ready\n']);
    });

    it('is still filtered by rowdy level first', () => {
      const { lines, destination } = capture();
      new Logger().withLevel('info');

      new Logger('sandbox', pino({ level: 'debug', base: undefined, timestamp: false }, destination)).debug('Dropped');

      expect(lines).toEqual([]);
    });
  });
});
