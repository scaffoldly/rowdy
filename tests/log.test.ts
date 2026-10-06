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
    Logger.unbind('req');
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
    Logger.unbind('req');
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
      expect(text()).toEqual(['ERROR rowdy e', 'WARN  rowdy w', 'INFO  rowdy i']);
    });

    it('follows ROWDY_LOG_LEVEL, case-insensitively', () => {
      process.env.ROWDY_LOG_LEVEL = 'WARN';
      const log = new Logger();
      log.info('i');
      log.warn('w');
      expect(text()).toEqual(['WARN  rowdy w']);
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
      expect(text()).toEqual(['DEBUG rowdy:vfs d']);
    });
  });

  describe('text format', () => {
    it('writes level, component, message and key=value fields, with no timestamp', () => {
      new Logger().child('vfs').info('flushed', { key: 'db/nuss.sqlite', size: 12288, ok: true });
      expect(text()).toEqual(['INFO  rowdy:vfs flushed key=db/nuss.sqlite size=12288 ok=true']);
    });

    it('quotes values with spaces unless they are already delimited', () => {
      new Logger().info('m', { a: 'two words', b: '', c: '{"json": "as is"}', d: 'Name(x=1 y=2)', e: '[1, 2]' });
      expect(text()).toEqual(['INFO  rowdy m a="two words" b="" c={"json": "as is"} d=Name(x=1 y=2) e=[1, 2]']);
    });

    it('keeps one event per line', () => {
      new Logger().warn('first\nsecond', { error: new Error('boom') });
      expect(text()).toHaveLength(1);
      expect(text()[0]).not.toContain('\n');
      expect(text()[0]).toContain('WARN  rowdy first \\n second error=');
      expect(text()[0]).toContain('Error: boom');
    });

    it('logs an error as name and message, with its stack only at debug and above', () => {
      const log = new Logger();
      log.warn('upstream error', { error: new Error('read ECONNRESET') });
      expect(text()).toEqual(['WARN  rowdy upstream error error="Error: read ECONNRESET"']);
      log.withLevel('debug');
      log.warn('upstream error', { error: new Error('read ECONNRESET') });
      expect(text()[1]).toContain('error="Error: read ECONNRESET \\n at ');
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
      expect(text()[4]).toBe('TRACE rowdy t');
    });
  });

  it('stamps bound context on every line until unbound', () => {
    const log = new Logger().child('lambda');
    Logger.bind({ req: '575b7bbe' });
    log.info('Request', { path: '/db' });
    new Logger().child('vfs').info('flushed');
    Logger.unbind('req');
    log.info('idle');
    expect(text()).toEqual([
      'INFO  rowdy:lambda Request path=/db req=575b7bbe',
      'INFO  rowdy:vfs flushed req=575b7bbe',
      'INFO  rowdy:lambda idle',
    ]);
  });

  it('emits one JSON object per line when ROWDY_LOG_FORMAT=json', () => {
    process.env.ROWDY_LOG_FORMAT = 'json';
    Logger.bind({ req: '575b7bbe' });
    new Logger().child('vfs').warn('lock failed', { path: '/s3/db', errno: 11 });
    expect(JSON.parse(text()[0]!)).toEqual({
      level: 'warn',
      component: 'vfs',
      msg: 'lock failed',
      path: '/s3/db',
      errno: 11,
      req: '575b7bbe',
    });
  });

  it('returns the same child for the same component', () => {
    const log = new Logger();
    expect(log.child('vfs')).toBe(log.child('vfs'));
    expect(log.child('vfs').component).toBe('vfs');
  });
});
