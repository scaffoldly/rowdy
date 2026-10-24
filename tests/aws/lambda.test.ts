import { Environment, Logger, Rowdy } from '@scaffoldly/rowdy';
import { LambdaPipeline, LambdaRequest } from '../../src/aws/lambda';
import { FileDescriptors, Result } from '../../src/pipeline';
import { ShellResponse } from '../../src/proxy/shell';
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

  // The command's environment as the first request leaves it.
  const envAfter = async (environment: Environment, event: unknown): Promise<Record<string, string | undefined>> => {
    await proxy(environment, event);
    const env = lastValueFrom(environment.Env);
    environment['_envVars'].complete();
    return env;
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

    it('briefs a request as method and path and a result as status, outcome, size and duration', () => {
      const pipeline = new LambdaPipeline(new Environment(new Logger()));
      const request = new LambdaRequest(pipeline, JSON.stringify(event()));
      expect(request.brief()).toEqual({ method: 'POST', path: '/tunnel/gc' });
      expect(new Result(pipeline, request, true, 194, 200).brief()).toEqual({
        status: 200,
        success: true,
        bytes: 194,
        duration: expect.stringMatching(/^\d+\.\d{2} ms$/),
      });
      expect(new Result(pipeline, request, false, 0).brief()).not.toHaveProperty('status');
    });

    it("relays the command's output a whole line at a time", () => {
      const lines: string[] = [];
      const spy = jest
        .spyOn(console, 'info')
        .mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
      try {
        const onData = ShellResponse.onData(new ShellResponse('node', new FileDescriptors()), 'stdout');
        onData(Buffer.from('first line\nsecond '));
        onData(Buffer.from('line\r\n\nthird, unterminated'));
        expect(lines).toEqual(['INFO Stdout first line', 'INFO Stdout second line']);
        onData(); // stream end
        expect(lines[2]).toBe('INFO Stdout third, unterminated');
      } finally {
        spy.mockRestore();
      }
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

  describe('runtime variables', () => {
    const LAMBDA_HOST = 'abc.lambda-url.us-east-1.on.aws';
    const withHosts = (...hosts: string[]): Environment => {
      const environment = withCrontab(CRON_LINE);
      environment.routes.withHosts(hosts);
      return environment;
    };
    const own = {
      HTTP_HOST: LAMBDA_HOST,
      HTTP_HOSTNAME: LAMBDA_HOST,
      HTTP_PORT: '443',
      HTTP_PROTO: 'https',
      HTTP_ORIGIN: `https://${LAMBDA_HOST}`,
    };

    it('default to localhost over http on port 80', async () => {
      const environment = new Environment(new Logger());
      environment['_envVars'].complete();
      expect(await lastValueFrom(environment.Env)).toMatchObject({
        HTTP_HOST: 'localhost',
        HTTP_HOSTNAME: 'localhost',
        HTTP_PORT: '80',
        HTTP_PROTO: 'http',
        HTTP_ORIGIN: 'http://localhost',
      });
    });

    it("describe a direct request by the Function URL's own host over https", async () => {
      const env = await envAfter(withHosts('app.example'), functionUrlEvent({ host: LAMBDA_HOST }));
      expect(env).toMatchObject(own);
    });

    it('describe a direct request by its own host when spec.hosts maps hosts to targets', async () => {
      const environment = withCrontab(CRON_LINE);
      environment.routes.withHosts({
        'app.example': 'arn:aws:cloudfront::442239336012:key-value-store/706d9bf2-5c29-4b7c-8900-89eb32d9723d',
      });
      expect(await envAfter(environment, functionUrlEvent({ host: LAMBDA_HOST }))).toMatchObject(own);
    });

    it('ignore forwarded headers whose origin is not in spec.hosts', async () => {
      const env = await envAfter(
        withHosts('app.example'),
        functionUrlEvent({
          host: LAMBDA_HOST,
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'https',
          'x-forwarded-port': '8443',
        })
      );
      expect(env).toMatchObject(own);
    });

    it('use forwarded headers unchecked without spec.hosts, warning once', async () => {
      const lines: string[] = [];
      const spy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        lines.push(args.join(' '));
      });
      LambdaRequest['uncheckedWarned'] = false;
      try {
        const event = functionUrlEvent({ host: LAMBDA_HOST, 'x-forwarded-host': 'app.example' });
        expect(await envAfter(withCrontab(CRON_LINE), event)).toMatchObject({
          HTTP_HOST: LAMBDA_HOST,
          HTTP_HOSTNAME: 'app.example',
          HTTP_PROTO: 'https',
          HTTP_ORIGIN: 'https://app.example',
        });
        await envAfter(withCrontab(CRON_LINE), event);
        expect(lines.filter((l) => l.includes('Forwarded Host Unchecked'))).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('use a forwarded host a wildcard in spec.hosts lists', async () => {
      const event = (host: string) => functionUrlEvent({ host: LAMBDA_HOST, 'x-forwarded-host': host });
      expect(await envAfter(withHosts('*.app.example'), event('www.app.example'))).toMatchObject({
        HTTP_HOSTNAME: 'www.app.example',
        HTTP_ORIGIN: 'https://www.app.example',
      });
      expect(await envAfter(withHosts('*.app.example'), event('app.example'))).toMatchObject({
        HTTP_HOSTNAME: 'app.example',
        HTTP_ORIGIN: 'https://app.example',
      });
      expect(await envAfter(withHosts('*.app.example'), event('a.b.app.example'))).toMatchObject(own);
      expect(await envAfter(withHosts('**.app.example'), event('a.b.app.example'))).toMatchObject({
        HTTP_HOSTNAME: 'a.b.app.example',
        HTTP_ORIGIN: 'https://a.b.app.example',
      });
    });

    it('use a forwarded host whose origin is in spec.hosts', async () => {
      const env = await envAfter(
        withHosts('app.example'),
        functionUrlEvent({ host: LAMBDA_HOST, 'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'https' })
      );
      expect(env).toMatchObject({
        HTTP_HOST: LAMBDA_HOST,
        HTTP_HOSTNAME: 'app.example',
        HTTP_PORT: '443',
        HTTP_PROTO: 'https',
        HTTP_ORIGIN: 'https://app.example',
      });
    });

    it('keep the port of a forwarded host and match it against spec.hosts', async () => {
      const event = functionUrlEvent({ host: LAMBDA_HOST, 'x-forwarded-host': 'app.example:8443' });
      expect(await envAfter(withHosts('https://app.example:8443'), event)).toMatchObject({
        HTTP_HOSTNAME: 'app.example:8443',
        HTTP_PORT: '8443',
        HTTP_ORIGIN: 'https://app.example:8443',
      });
      expect(await envAfter(withHosts('app.example'), event)).toMatchObject(own);
    });

    it('refuse a scheme spec.hosts does not list', async () => {
      const env = await envAfter(
        withHosts('app.example'),
        functionUrlEvent({ host: LAMBDA_HOST, 'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'http' })
      );
      expect(env).toMatchObject(own);
    });

    it("prefer a CDN's own scheme header to X-Forwarded-Proto", async () => {
      const cloudfront = await envAfter(
        withHosts('http://app.example'),
        functionUrlEvent({
          host: LAMBDA_HOST,
          'x-forwarded-host': 'app.example',
          'cloudfront-forwarded-proto': 'http',
          'x-forwarded-proto': 'https',
        })
      );
      expect(cloudfront).toMatchObject({ HTTP_PROTO: 'http', HTTP_PORT: '80', HTTP_ORIGIN: 'http://app.example' });

      const cloudflare = await envAfter(
        withHosts('http://app.example'),
        functionUrlEvent({
          host: LAMBDA_HOST,
          'x-forwarded-host': 'app.example',
          'cf-visitor': '{"scheme":"http"}',
          'x-forwarded-proto': 'https',
        })
      );
      expect(cloudflare).toMatchObject({ HTTP_PROTO: 'http', HTTP_ORIGIN: 'http://app.example' });
    });

    it('read RFC 7239 Forwarded', async () => {
      const env = await envAfter(
        withHosts('app.example'),
        functionUrlEvent({
          host: LAMBDA_HOST,
          forwarded: 'for=192.0.2.60;proto=https;host="app.example", for=198.51.100.17',
        })
      );
      expect(env).toMatchObject({ HTTP_HOSTNAME: 'app.example', HTTP_ORIGIN: 'https://app.example' });
    });

    it("take a schedule's values from its URI", async () => {
      const named = await envAfter(withCrontab(CRON_LINE), cronEvent(CRON_LINE));
      expect(named).toMatchObject({
        HTTP_HOST: 'localhost:3000',
        HTTP_HOSTNAME: 'localhost',
        HTTP_PORT: '3000',
        HTTP_PROTO: 'https',
        HTTP_ORIGIN: 'https://localhost:3000',
      });

      const line = '0 4 * * MON http://localhost/reports/weekly';
      const implied = await envAfter(withCrontab(line), cronEvent(line));
      expect(implied).toMatchObject({
        HTTP_HOST: 'localhost',
        HTTP_PORT: '80',
        HTTP_PROTO: 'http',
        HTTP_ORIGIN: 'http://localhost',
      });
    });
  });
});
