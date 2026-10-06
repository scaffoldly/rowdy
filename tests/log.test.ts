import { Logger, mask, maskEnv, maskHeaders, maskJson, maskQuery, maskUrl } from '../src/log';

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
      expect(out).toContain('"proxyEndpoint":"https://ecr"');
      expect(out).toContain('"routes":"./routes.yaml"');
      expect(out).toContain('"Expiration":"1970-01-01T00:00:00.000Z"');
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
    new Logger().withLevel(undefined).withFormat(undefined);
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
    new Logger().withLevel(undefined).withFormat(undefined);
    Logger.unbind('req', 'requestId', 'instance');
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
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
});
