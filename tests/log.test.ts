import { Observable, of, throwError, race, timer, map, NEVER } from 'rxjs';
import pino from 'pino';
import { ILoggable, Logger, mask, maskEnv, maskHeaders, maskJson, maskQuery, maskUrl, Trace } from '../src/log';

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
    const log = new Logger().child('lambda');
    class Arg implements ILoggable {
      constructor(private readonly n: number) {}
      repr(): string {
        return `Arg(${this.n})`;
      }
    }
    class Thing {
      @Trace(log)
      into(arg: Arg): Observable<string> {
        return of(`got ${arg.repr()}`);
      }

      @Trace(log)
      fail(): Observable<string> {
        return throwError(() => new Error('boom'));
      }

      @Trace(log)
      slow(): Observable<string> {
        return NEVER;
      }

      @Trace(log)
      fast(): Observable<string> {
        return timer(1).pipe(map(() => 'fast'));
      }
    }
    const duration = expect.stringMatching(/^\d+\.\d\d ms$/);

    it('is silent below trace', () => {
      new Logger().withLevel('debug');
      expect(new Thing().into(new Arg(1)).subscribe()).toBeDefined();
      expect(text()).toEqual([]);
    });

    it('logs the call, each emission and the completion, with the component and the duration', (done) => {
      new Logger().withLevel('trace');
      new Thing().into(new Arg(1)).subscribe({
        complete: () => {
          expect(text()).toEqual([
            'TRACE Lambda Thing.into Called Args: [Arg(1)]',
            expect.stringMatching(/^TRACE Lambda Thing.into Emitted Duration: \d+\.\d\d ms Value: got Arg\(1\)$/),
            expect.stringMatching(/^TRACE Lambda Thing.into Completed Duration: \d+\.\d\d ms Emissions: 1$/),
          ]);
          done();
        },
      });
    });

    it('logs a failure with the error', (done) => {
      new Logger().withLevel('trace');
      new Thing().fail().subscribe({
        error: () => {
          expect(text()[0]).toBe('TRACE Lambda Thing.fail Called');
          expect(text()[1]).toMatch(
            /^TRACE Lambda Thing.fail Failed Duration: \d+\.\d\d ms Emissions: 0 Error: Error: boom/
          );
          expect(text()).toHaveLength(2);
          done();
        },
      });
    });

    it('logs the loser of a race as unsubscribed', (done) => {
      new Logger().withLevel('trace');
      const thing = new Thing();
      race([thing.slow(), thing.fast()]).subscribe({
        complete: () => {
          expect(text()).toEqual([
            'TRACE Lambda Thing.slow Called',
            'TRACE Lambda Thing.fast Called',
            expect.stringMatching(/^TRACE Lambda Thing.fast Emitted Duration: .* Value: fast$/),
            expect.stringMatching(/^TRACE Lambda Thing.slow Unsubscribed Duration: .* Emissions: 0$/),
            expect.stringMatching(/^TRACE Lambda Thing.fast Completed Duration: .* Emissions: 1$/),
          ]);
          done();
        },
      });
    });

    it('is JSON like any other line', (done) => {
      new Logger().withLevel('trace').withFormat('json');
      new Thing().into(new Arg(2)).subscribe({
        complete: () => {
          expect(JSON.parse(text()[1]!)).toEqual({
            level: 'trace',
            component: 'lambda',
            msg: 'Thing.into Emitted',
            duration,
            value: 'got Arg(2)',
          });
          done();
        },
      });
    });
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
