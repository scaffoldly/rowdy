import { CRIServices, Docs, ImageService, Router, RuntimeService } from '@scaffoldly/rowdy-grpc';

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

        const body = (await new Response(res.body).json()) as Docs;
        expect(Object.keys(body.paths!).length).toEqual(NUM_PATHS);
      });

      it('should provide docs with html header', async () => {
        const res = await router.docs('text/html');
        expect(res.status).toBe(200);
        expect(res.body).toBeDefined();
        expect(res.header!.get('content-type')).toMatch(/text\/html/);

        const body = await new Response(res.body).text();
        expect(body).toContain('<h1>TODO</h1>');
      });

      it('should reject unsupported accept header', async () => {
        const res = await router.docs('application/xml');
        expect(res.status).toBe(406);
        expect(res.body).toBeDefined();
        expect(res.header!.get('content-type')).toMatch(/text\/plain/);

        const body = await new Response(res.body).text();
        expect(body).toContain('Not Acceptable');
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
