import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createServer, IncomingHttpHeaders, Server } from 'http';
import { AddressInfo } from 'net';
import { Logger } from '../../../src/log';
import { SandboxEnvironment } from '../../../src/sandbox/internal/environment';

describe('sandbox environment http', () => {
  const seen: { path?: string; headers: IncomingHttpHeaders }[] = [];
  let registry: Server;
  let store: Server;
  const origin = (server: Server): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const listen = (handler: Parameters<typeof createServer>[1]): Promise<Server> =>
    new Promise((resolve) => {
      const server = createServer(handler).listen(0, '127.0.0.1', () => resolve(server));
    });

  beforeAll(async () => {
    store = await listen((req, res) => {
      seen.push({ path: req.url, headers: req.headers });
      res.end('blob');
    });
    registry = await listen((req, res) => {
      seen.push({ path: req.url, headers: req.headers });
      const to: Record<string, string> = {
        '/v2/blob': `${origin(store)}/storage/blob`,
        '/v2/moved': '/v2/here',
        '/v2/loop': '/v2/loop',
      };
      if (to[req.url!]) {
        res.writeHead(307, { location: to[req.url!] }).end();
      } else {
        res.end('here');
      }
    });
  });

  afterAll(() => {
    registry.close();
    store.close();
  });

  const environment = (): SandboxEnvironment => new SandboxEnvironment(new Logger());

  it("leaves redirects out of axios's own adapter, which breaks on a Cloudflare Worker", () => {
    expect(environment().http.defaults.maxRedirects).toBe(0);
  });

  it("follows a redirect to another origin without the registry's Authorization", async () => {
    seen.length = 0;

    const { data } = await environment().http.get(`${origin(registry)}/v2/blob`, {
      headers: { Authorization: 'Bearer registry-token' },
    });

    expect(data).toBe('blob');
    expect(seen.map(({ path }) => path)).toEqual(['/v2/blob', '/storage/blob']);
    expect(seen[1]!.headers.authorization).toBeUndefined();
  });

  it('keeps Authorization on a redirect within the origin', async () => {
    seen.length = 0;

    const { data } = await environment().http.get(`${origin(registry)}/v2/moved`, {
      headers: { Authorization: 'Bearer registry-token' },
    });

    expect(data).toBe('here');
    expect(seen[1]!.headers.authorization).toBe('Bearer registry-token');
  });

  it('gives up after 5 redirects', async () => {
    seen.length = 0;

    const error = await environment()
      .http.get(`${origin(registry)}/v2/loop`)
      .catch((e) => e);

    expect(error.response.status).toBe(307);
    expect(seen).toHaveLength(6);
  });
});
