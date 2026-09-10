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
