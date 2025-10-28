import { createMethodUrl } from '@connectrpc/connect/protocol';
import { CRIServices, Docs, ImageService, Router, RuntimeService, Request, CRI } from '@scaffoldly/rowdy-grpc';
import { Readable } from 'stream';

const NUM_PATHS = 35;

describe('router', () => {
  it('should build an empty router', () => {
    const router = new Router(new AbortController().signal);
    expect(router.size).toEqual(0);
  });

  it('should install services', () => {
    const router = new Router(new AbortController().signal);
    router.withServices(new CRIServices());
    expect(router.size).toEqual(NUM_PATHS);
  });

  it('should support chaining', () => {
    const router = new Router(new AbortController().signal).withServices(
      new CRIServices().Runtime.with({}).and().Image.with({})
    );
    expect(router.size).toEqual(NUM_PATHS);
  });

  describe('routing', () => {
    // Create your custom router
    const router = new Router(new AbortController().signal).withServices(
      new CRIServices()
        .and()
        .Runtime.with({
          version: async () => {
            return {
              runtimeApiVersion: '1.2.3',
              version: '4.5.6',
              runtimeName: 'test',
              runtimeVersion: '7.8.9',
            };
          },
        })
        .and()
        .Image.with({
          listImages: () => {
            return {
              images: [
                {
                  id: 'image1',
                  repoTags: ['tag1'],
                  repoDigests: ['digest1'],
                  pinned: false,
                  size: 123456n,
                  username: 'user1',
                },
              ],
            };
          },
        })
    );

    describe('docs', () => {
      it('should provide docs with json header', async () => {
        const res = await router.docs('application/json');
        expect(res.status).toBe(200);
        expect(res.body).toBeDefined();
        expect(res.header!.get('content-type')).toMatch(/application\/json/);
        expect(res.header!.get('x-acceptable')).toBe('application/json, text/html');
        expect(res.header!.get('x-accept')).toBe('application/json');

        const body = (await new Response(res.body).json()) as Docs;
        expect(Object.keys(body.paths!).length).toEqual(NUM_PATHS);
      });

      it('should provide docs with html header', async () => {
        const res = await router.docs('text/html');
        expect(res.status).toBe(200);
        expect(res.body).toBeDefined();
        expect(res.header!.get('content-type')).toMatch(/text\/html/);
        expect(res.header!.get('x-acceptable')).toBe('application/json, text/html');
        expect(res.header!.get('x-accept')).toBe('text/html');

        const body = await new Response(res.body).text();
        expect(body).toContain('<redoc spec-url="openapi.json"></redoc>');
        expect(body).toContain('<title>@scaffoldly/rowdy-grpc</title>');
      });

      it('should reject unsupported accept header', async () => {
        const res = await router.docs('application/xml');
        expect(res.status).toBe(406);
        expect(res.body).toBeUndefined();
        expect(res.header!.get('content-type')).toMatch(/text\/plain/);
        expect(res.header!.get('x-acceptable')).toBe('application/json, text/html');
        expect(res.header!.get('x-accept')).toBe('application/xml');
      });

      it('should prefer html for browsers', async () => {
        const res = await router.docs(
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
        );
        expect(res.status).toBe(200);
        expect(res.body).toBeDefined();
        expect(res.header!.get('content-type')).toMatch(/text\/html/);
        expect(res.header!.get('x-acceptable')).toBe('application/json, text/html');
        expect(res.header!.get('x-accept')).toBe(
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
        );
      });

      it('should prefer json for */*', async () => {
        const res = await router.docs('*/*');
        expect(res.status).toBe(200);
        expect(res.body).toBeDefined();
        expect(res.header!.get('content-type')).toMatch(/application\/json/);
        expect(res.header!.get('x-acceptable')).toBe('application/json, text/html');
        expect(res.header!.get('x-accept')).toBe('*/*');
      });
    });

    describe('route', () => {
      it('should return 404 for unknown path', async () => {
        const req: Request = {
          url: 'http://localhost/unknown/path',
          method: 'GET',
          header: new Headers(),
          body: Readable.from([]),
          signal: new AbortController().signal,
          httpVersion: '1.1',
        };
        const res = await router.route(req);
        expect(res.status).toBe(404);
      });

      it('should route to images', async () => {
        const req: Request = {
          url: createMethodUrl('http://test', CRI.ImageService.method.listImages),
          method: 'POST',
          header: new Headers({ 'Content-Type': 'application/grpc' }),
          body: Readable.from([]),
          signal: new AbortController().signal,
          httpVersion: '1.1',
        };
        const res = await router.route(req);
        expect(res.status).toBe(200);
      });

      it('should route to runtime', async () => {
        const req: Request = {
          url: createMethodUrl('http://test', CRI.RuntimeService.method.version),
          method: 'POST',
          header: new Headers({ 'Content-Type': 'application/grpc' }),
          body: Readable.from([]),
          signal: new AbortController().signal,
          httpVersion: '1.1',
        };
        const res = await router.route(req);
        expect(res.status).toBe(200);
      });

      it('should route with a prefix', async () => {
        const router = new Router(new AbortController().signal).withServices(new CRIServices()).withPrefix('/prefix');
        const req: Request = {
          url: createMethodUrl('http://test/prefix', CRI.RuntimeService.method.version),
          method: 'POST',
          header: new Headers({ 'Content-Type': 'application/grpc' }),
          body: Readable.from([]),
          signal: new AbortController().signal,
          httpVersion: '1.1',
        };
        const res = await router.route(req);
        expect(res.status).toBe(200);
      });

      it('should return 404 with a prefix mismatch', async () => {
        const router = new Router(new AbortController().signal).withServices(new CRIServices()).withPrefix('/prefix');
        const req: Request = {
          url: createMethodUrl('http://test', CRI.RuntimeService.method.version),
          method: 'POST',
          header: new Headers({ 'Content-Type': 'application/grpc' }),
          body: Readable.from([]),
          signal: new AbortController().signal,
          httpVersion: '1.1',
        };
        const res = await router.route(req);
        expect(res.status).toBe(404);
      });

      it('should return docs at root', async () => {
        const router = new Router(new AbortController().signal).withServices(new CRIServices());
        const req: Request = {
          url: 'http://test/',
          method: 'GET',
          header: new Headers({ Accept: 'application/json' }),
          body: Readable.from([]),
          signal: new AbortController().signal,
          httpVersion: '1.1',
        };
        const res = await router.route(req);
        expect(res.status).toBe(200);
        expect(res.header!.get('content-type')).toMatch(/application\/json/);
      });

      it('should return html docs at root for browsers', async () => {
        const router = new Router(new AbortController().signal).withServices(new CRIServices());
        const req: Request = {
          url: 'http://test/',
          method: 'GET',
          header: new Headers({
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          }),
          body: Readable.from([]),
          signal: new AbortController().signal,
          httpVersion: '1.1',
        };
        const res = await router.route(req);
        expect(res.status).toBe(200);
        expect(res.header!.get('content-type')).toMatch(/text\/html/);
      });

      it('should return html docs at root for browsers with prefix', async () => {
        const router = new Router(new AbortController().signal).withServices(new CRIServices()).withPrefix('/prefix');
        const req: Request = {
          url: 'http://test/prefix/',
          method: 'GET',
          header: new Headers({
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          }),
          body: Readable.from([]),
          signal: new AbortController().signal,
          httpVersion: '1.1',
        };
        const res = await router.route(req);
        expect(res.status).toBe(200);
        expect(res.header!.get('content-type')).toMatch(/text\/html/);
      });

      it('should return docs at root with prefix', async () => {
        const router = new Router(new AbortController().signal).withServices(new CRIServices()).withPrefix('/prefix');
        const req: Request = {
          url: 'http://test/prefix/',
          method: 'GET',
          header: new Headers({ Accept: 'application/json' }),
          body: Readable.from([]),
          signal: new AbortController().signal,
          httpVersion: '1.1',
        };
        const res = await router.route(req);
        expect(res.status).toBe(200);
        expect(res.header!.get('content-type')).toMatch(/application\/json/);
      });

      it('should return openapi.json', async () => {
        const router = new Router(new AbortController().signal).withServices(new CRIServices());
        const req: Request = {
          url: 'http://test/openapi.json',
          method: 'GET',
          header: new Headers({ Accept: 'application/json' }),
          body: Readable.from([]),
          signal: new AbortController().signal,
          httpVersion: '1.1',
        };
        const res = await router.route(req);
        expect(res.status).toBe(200);
        expect(res.header!.get('content-type')).toMatch(/application\/json/);
      });

      it('should return openapi.json with prefix', async () => {
        const router = new Router(new AbortController().signal).withServices(new CRIServices()).withPrefix('/prefix');
        const req: Request = {
          url: 'http://test/prefix/openapi.json',
          method: 'GET',
          header: new Headers({ Accept: 'application/json' }),
          body: Readable.from([]),
          signal: new AbortController().signal,
          httpVersion: '1.1',
        };
        const res = await router.route(req);
        expect(res.status).toBe(200);
        expect(res.header!.get('content-type')).toMatch(/application\/json/);
      });
    });

    describe('local', () => {
      it('should route to runtime service', async () => {
        const client = RuntimeService.client(router.local);
        expect((await client.version({ version: '1.0.0' })).runtimeApiVersion).toBe('1.2.3');
      });

      it('should route to image service', async () => {
        const client = ImageService.client(router.local);
        expect((await client.listImages({})).images.length).toBe(1);
      });
    });

    describe('server', () => {
      const { start, stop } = router.server();

      it('should route to image service', async () => {
        const transport = await start();
        const client = ImageService.client(transport);
        expect((await client.listImages({})).images.length).toBe(1);
        await stop();
      });

      it('should route to runtime service', async () => {
        const transport = await start();
        const client = RuntimeService.client(transport);
        expect((await client.version({ version: '1.0.0' })).runtimeApiVersion).toBe('1.2.3');
        await stop();
      });
    });
  });
});
