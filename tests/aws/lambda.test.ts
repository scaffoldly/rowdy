import { Environment, Logger, Rowdy } from '@scaffoldly/rowdy';
import { LambdaPipeline, LambdaRequest } from '../../src/aws/lambda';
import { HttpProxy } from '../../src/proxy/http';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { lastValueFrom } from 'rxjs';

const CRON_LINE = '*/15 * * * * POST https://localhost:3000/tunnel/gc';

const functionUrlEvent = (headers: Record<string, string>): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: '$default',
    rawPath: '/tunnel/gc',
    rawQueryString: '',
    headers,
    requestContext: { http: { method: 'POST' } },
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

const cronEvent = (line: string): unknown => ({
  apiVersion: 'rowdy.run/v1alpha1',
  kind: 'Cron',
  spec: { line },
});

describe('aws lambda runtime', () => {
  const proxy = async (environment: Environment, event: unknown): Promise<HttpProxy<LambdaPipeline>> => {
    const pipeline = new LambdaPipeline(environment);
    const request = new LambdaRequest(pipeline, JSON.stringify(event));
    return (await lastValueFrom(request['intoHttp']())) as HttpProxy<LambdaPipeline>;
  };

  const withCrontab = (...lines: string[]): Environment => {
    const environment = new Environment(new Logger());
    environment.routes.withCrontab(lines);
    return environment;
  };

  describe('logging', () => {
    const CANARIES = [
      'hunter2-canary-authorization',
      'canary-cookie-value',
      's3cr3t-canary-header',
      'canary-query-token',
      'canary-body',
    ];

    const event = (): unknown => ({
      ...functionUrlEvent({
        host: 'example.com',
        authorization: 'Bearer hunter2-canary-authorization',
        cookie: 'sid=canary-cookie-value',
        'X-Secret': 's3cr3t-canary-header',
      }),
      rawQueryString: 'page=2&token=canary-query-token',
      cookies: ['sid=canary-cookie-value'],
      body: JSON.stringify({ password: 'canary-body' }),
    });

    it('never writes header values that are credentials, cookies, query secrets or the body', async () => {
      const lines: string[] = [];
      const capture = (...args: unknown[]): void => void lines.push(args.map(String).join(' '));
      const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
        jest.spyOn(console, level).mockImplementation(capture)
      );
      const before = { debug: process.env.ROWDY_DEBUG, trace: process.env.ROWDY_TRACE };
      process.env.ROWDY_DEBUG = 'true';
      process.env.ROWDY_TRACE = 'true';
      try {
        const environment = new Environment(new Logger());
        const pipeline = new LambdaPipeline(environment);
        const request = new LambdaRequest(pipeline, JSON.stringify(event()));
        const proxied = (await lastValueFrom(request['intoHttp']())) as HttpProxy<LambdaPipeline>;
        // what `Request`, `Received invocation` and @Trace print
        lines.push(Logger.asPrimitive(request) as string, Logger.asPrimitive(proxied) as string);
        // an event rowdy does not understand is logged at warn
        new LambdaRequest(pipeline, JSON.stringify({ secret: CANARIES[0] }))['intoHttp']();
      } finally {
        spies.forEach((spy) => spy.mockRestore());
        for (const [key, value] of [
          ['ROWDY_DEBUG', before.debug],
          ['ROWDY_TRACE', before.trace],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      const output = lines.join('\n');
      for (const canary of CANARIES) {
        expect(output).not.toContain(canary);
      }
      // still useful: names, method, path and sizes are there
      expect(output).toContain('http method=POST path=/tunnel/gc');
      expect(output).toContain('authorization=');
      expect(output).toContain('X-Secret=');
      expect(output).toContain('token=');
      expect(output).toContain('cookies=1');
    });

    it('summarizes a non-JSON payload by size only', () => {
      const request = new LambdaRequest(new LambdaPipeline(new Environment(new Logger())), 'canary-raw-payload');
      expect(request.repr()).toBe('LambdaRequest(text bytes=18)');
    });
  });

  describe('cron events', () => {
    it('should proxy a declared cron line', async () => {
      const cron = await proxy(withCrontab(CRON_LINE), cronEvent(CRON_LINE));

      expect(cron.method).toBe('POST');
      expect(cron.uri.toString()).toBe('https://localhost:3000/tunnel/gc');
      expect(cron.body.length).toBe(0);
      expect(cron.headers.get('host')).toBe('localhost:3000');
      expect(cron.headers.get('user-agent')).toBe(`${new Environment(new Logger()).userAgent} (cron)`);
      expect(cron.headers.get(Rowdy.HEADERS.CRON)).toBe(CRON_LINE);
    });

    it('should default the method to GET', async () => {
      const line = '0 3 * * * https://localhost:3000/tunnel/gc';
      const cron = await proxy(withCrontab(line), cronEvent(line));

      expect(cron.method).toBe('GET');
      expect(cron.uri.toString()).toBe('https://localhost:3000/tunnel/gc');
    });

    it('should reject a line the manifest does not declare', async () => {
      const cron = await proxy(withCrontab(CRON_LINE), cronEvent('0 3 * * * https://localhost:3000/other'));

      expect(cron.uri.protocol).toBe('rowdy:');
      expect(cron.uri.error).toContain('not declared in spec.crontab');
    });

    it('should reject an unparseable line', async () => {
      const cron = await proxy(withCrontab(CRON_LINE), cronEvent('not a crontab line'));

      expect(cron.uri.protocol).toBe('rowdy:');
      expect(cron.uri.error).toContain('Unparseable Cron Event');
    });
  });

  describe('function url events', () => {
    it('should strip an inbound X-Rowdy-Cron header', async () => {
      const http = await proxy(
        withCrontab(CRON_LINE),
        functionUrlEvent({ host: 'example.com', 'X-Rowdy-Cron': CRON_LINE })
      );

      expect(http.headers.get(Rowdy.HEADERS.CRON)).toBeUndefined();
      expect(http.source.headers[Rowdy.HEADERS.CRON]).toBeUndefined();
      expect(http.headers.get('host')).toBe('example.com');
    });

    it('should keep other headers', async () => {
      const http = await proxy(withCrontab(CRON_LINE), functionUrlEvent({ host: 'example.com', 'X-Trace': 'abc' }));

      expect(http.headers.get('x-trace')).toBe('abc');
    });
  });
});
