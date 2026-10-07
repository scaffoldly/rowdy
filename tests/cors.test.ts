import { Cors, Environment, Logger, Routes } from '@scaffoldly/rowdy';
import { LambdaPipeline, LambdaRequest } from '../src/aws/lambda';
import { HttpProxy, HttpResponse } from '../src/proxy/http';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { lastValueFrom } from 'rxjs';

const APP = 'https://app.example';

describe('cors', () => {
  describe('parse', () => {
    it('returns undefined for none', () => {
      expect(Cors.parse('/api', 'none')).toBeUndefined();
    });

    it('normalizes origins, methods and headers', () => {
      const cors = Cors.parse('/api', {
        origins: ['HTTPS://App.Example/'],
        methods: ['get', 'post'],
        headers: ['Content-Type'],
        expose: ['X-Request-Id'],
        credentials: true,
        maxAge: 600,
      })!;
      expect(cors.spec).toEqual({
        origins: [APP],
        methods: ['GET', 'POST'],
        headers: ['content-type'],
        expose: ['x-request-id'],
        credentials: true,
        maxAge: 600,
      });
    });

    it('defaults methods and headers to any, credentials to false', () => {
      expect(Cors.parse('/api', { origins: [APP] })!.spec).toEqual({
        origins: [APP],
        methods: ['*'],
        headers: ['*'],
        expose: [],
        credentials: false,
      });
    });

    it.each([
      [{}, "CORS for '/api' needs origins"],
      [{ origins: [] }, "CORS for '/api' needs origins"],
      [{ origins: 'https://app.example' }, "CORS origins for '/api' must be a list"],
      [{ origins: ['app.example'] }, "Invalid CORS origin 'app.example' for '/api'"],
      [{ origins: [APP], credentials: 'yes' }, "CORS credentials for '/api' must be true or false"],
      [{ origins: [APP], maxAge: -1 }, "CORS maxAge for '/api' must be a non-negative integer"],
      [{ origins: [APP], allow: true }, "Unknown CORS key 'allow' for '/api'"],
      ['all', "Invalid CORS for '/api', expected 'none' or a policy"],
    ])('rejects %j', (spec, message) => {
      expect(() => Cors.parse('/api', spec)).toThrow(message);
    });
  });

  describe('preflight', () => {
    const preflight = (spec: unknown, origin: string, method = 'DELETE', headers?: string) =>
      Cors.parse('/api', spec)!.preflight(origin, method, headers);

    it('allows a listed origin without credentials', () => {
      expect(preflight({ origins: [APP], methods: ['GET', 'DELETE'], headers: ['content-type'] }, APP)).toEqual({
        'access-control-allow-origin': APP,
        'access-control-allow-methods': 'GET, DELETE',
        'access-control-allow-headers': 'content-type',
        vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      });
    });

    it('sends no CORS headers for an origin that is not listed', () => {
      expect(preflight({ origins: [APP] }, 'https://evil.example')).toEqual({
        vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      });
    });

    it('answers any origin with a literal * and no credentials', () => {
      expect(preflight({ origins: ['*'] }, 'https://evil.example', 'DELETE', 'x-custom')).toEqual({
        'access-control-allow-origin': '*',
        'access-control-allow-methods': '*',
        'access-control-allow-headers': '*',
        vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      });
    });

    it('echoes the origin, method and headers only when the route opts into * with credentials', () => {
      expect(
        preflight({ origins: ['*'], credentials: true, maxAge: 3600 }, 'https://evil.example', 'DELETE', 'x-custom')
      ).toEqual({
        'access-control-allow-origin': 'https://evil.example',
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'DELETE',
        'access-control-allow-headers': 'x-custom',
        'access-control-max-age': '3600',
        vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      });
    });

    it('sends credentials for a listed origin', () => {
      expect(preflight({ origins: [APP], credentials: true }, APP)).toMatchObject({
        'access-control-allow-origin': APP,
        'access-control-allow-credentials': 'true',
      });
    });
  });

  describe('response', () => {
    it('allows a listed origin', () => {
      expect(
        Cors.parse('/api', { origins: [APP], expose: ['x-request-id'], credentials: true })!.response(APP)
      ).toEqual({
        'access-control-allow-origin': APP,
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'x-request-id',
        vary: 'Origin',
      });
    });

    it('sends only Vary for an origin that is not listed, or no origin', () => {
      const cors = Cors.parse('/api', { origins: [APP], credentials: true })!;
      expect(cors.response('https://evil.example')).toEqual({ vary: 'Origin' });
      expect(cors.response(undefined)).toEqual({ vary: 'Origin' });
    });
  });
});

describe('routes cors', () => {
  const routes = (): Routes =>
    Routes.fromSchema({
      default: 'http://localhost:3000/',
      cors: {
        '/oauth{/*path}': 'none',
        '/api{/*path}': { origins: [APP], credentials: true },
        '{/*path}': { origins: ['*'] },
      },
    });

  it('picks the first pattern that matches', () => {
    const r = routes();
    expect(r.intoCors('/oauth/token')).toBeUndefined();
    expect(r.intoCors('/api/status')!.spec.origins).toEqual([APP]);
    expect(r.intoCors('/api')!.spec.origins).toEqual([APP]);
    expect(r.intoCors('/')!.spec.origins).toEqual(['*']);
  });

  it('applies no CORS to a path no pattern matches', () => {
    expect(Routes.fromSchema({ default: 'http://localhost:3000/' }).intoCors('/api')).toBeUndefined();
    expect(Routes.default().intoCors('/')).toBeUndefined();
  });

  it('round-trips through the manifest data url', () => {
    const r = Routes.fromDataURL(routes().intoDataURL());
    expect(r.cors).toEqual(routes().cors);
    expect(r.intoCors('/oauth/token')).toBeUndefined();
    expect(r.intoCors('/api/status')!.spec.credentials).toBe(true);
  });

  it('keeps cors when merged, later entries winning', () => {
    const r = Routes.empty()
      .withCors({ '/api{/*path}': 'none' })
      .merge(Routes.empty().withCors({ '/api{/*path}': { origins: [APP] } }));
    expect(r.intoCors('/api/x')!.spec.origins).toEqual([APP]);
  });

  it('fails on an invalid policy or pattern', () => {
    expect(() => Routes.fromSchema({ cors: { '/api': { origins: [] } } })).toThrow("CORS for '/api' needs origins");
    expect(() => Routes.fromSchema({ cors: { '/api{': 'none' } })).toThrow("Invalid CORS path '/api{'");
  });

  it('accepts a bare spec with only cors', () => {
    expect(Routes.fromURL(`cors:\n  '{/*path}': none\n`).cors).toEqual({ '{/*path}': 'none' });
  });
});

describe('http proxy cors', () => {
  const event = (method: string, rawPath: string, headers: Record<string, string>): APIGatewayProxyEventV2 =>
    ({
      version: '2.0',
      routeKey: '$default',
      rawPath,
      rawQueryString: '',
      headers: { host: 'example.com', ...headers },
      requestContext: { http: { method } },
      isBase64Encoded: false,
    }) as unknown as APIGatewayProxyEventV2;

  const invoke = async (routes: Routes, e: APIGatewayProxyEventV2): Promise<HttpResponse> => {
    const environment = new Environment(new Logger());
    environment['_routes'] = routes;
    const pipeline = new LambdaPipeline(environment);
    const request = new LambdaRequest(pipeline, JSON.stringify(e));
    const proxy = (await lastValueFrom(request['intoHttp']())) as HttpProxy<LambdaPipeline>;
    return lastValueFrom(proxy.invoke());
  };

  // A rowdy:// target answers with rowdy's own `access-control-allow-origin: *`, standing in for an
  // app that sets its own CORS headers.
  const routes = Routes.fromSchema({
    paths: { '/app{/*path}': 'rowdy://http:200/', '/api{/*path}': 'rowdy://http:200/' },
    cors: {
      '/api{/*path}': { origins: [APP], methods: ['GET', 'DELETE'], credentials: true },
    },
  });

  it('answers a preflight itself on a route with a policy', async () => {
    const response = await invoke(
      routes,
      event('OPTIONS', '/api/thing', { origin: APP, 'access-control-request-method': 'DELETE' })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(APP);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, DELETE');
  });

  it('refuses a preflight from an origin that is not listed', async () => {
    const response = await invoke(
      routes,
      event('OPTIONS', '/api/thing', { origin: 'https://evil.example', 'access-control-request-method': 'DELETE' })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeUndefined();
    expect(response.headers.get('access-control-allow-credentials')).toBeUndefined();
  });

  it("replaces the upstream's CORS headers on a route with a policy", async () => {
    const response = await invoke(routes, event('GET', '/api/thing', { origin: APP }));
    expect(response.headers.get('access-control-allow-origin')).toBe(APP);
    expect(response.headers.get('access-control-allow-methods')).toBeUndefined();
    expect(response.headers.get('vary')).toBe('Origin');

    const evil = await invoke(routes, event('GET', '/api/thing', { origin: 'https://evil.example' }));
    expect(evil.headers.get('access-control-allow-origin')).toBeUndefined();
  });

  it("leaves the upstream's headers alone on a route without a policy", async () => {
    const response = await invoke(routes, event('GET', '/app/thing', { origin: 'https://evil.example' }));
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeUndefined();
    expect(response.headers.get('vary')).toBeUndefined();
  });

  it('passes a preflight through to the upstream on a route without a policy', async () => {
    const response = await invoke(
      routes,
      event('OPTIONS', '/app/thing', { origin: APP, 'access-control-request-method': 'DELETE' })
    );
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});
