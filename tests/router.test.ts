import { createMethodUrl, UniversalServerRequest } from '@connectrpc/connect/protocol';
import { CRI, Router, toBinary } from '@scaffoldly/rowdy-grpc';
import { Readable } from 'stream';

describe('router', () => {
  it('should build an empty router', () => {
    const router = new Router(new AbortController().signal);
    expect(router.paths.size).toEqual(0);
  });

  it('should install the CRI image service', () => {
    const router = new Router(new AbortController().signal);
    router.withService(CRI.ImageService, {});
    expect(router.paths.size).toEqual(5);
  });

  it('should install the CRI runtime service', () => {
    const router = new Router(new AbortController().signal);
    router.withService(CRI.RuntimeService, {});
    expect(router.paths.size).toEqual(30);
  });

  it('should install multiple services', () => {
    const router = new Router(new AbortController().signal);
    router.withService(CRI.RuntimeService, {});
    router.withService(CRI.ImageService, {});
    expect(router.paths.size).toEqual(35);
  });

  it('should support chaining', () => {
    const router = new Router(new AbortController().signal)
      .withService(CRI.RuntimeService, {})
      .withService(CRI.ImageService, {});
    expect(router.paths.size).toEqual(35);
  });

  describe('basic http 1.1 routing', () => {
    const router = new Router(new AbortController().signal)
      .withService(CRI.ImageService, {
        listImages: () => {
          return {
            $typeName: 'runtime.v1.ListImagesResponse',
            images: [],
          };
        },
      })
      .withService(CRI.RuntimeService, {
        version: () => {
          return {
            $typeName: 'runtime.v1.VersionResponse',
            runtimeApiVersion: '1.0.0',
            version: '1.0.0',
            runtimeName: 'test',
            runtimeVersion: '1.0.0',
          };
        },
      });

    it('should route to image service', async () => {
      const url = createMethodUrl('http://localhost', CRI.ImageService.method.listImages);

      expect(url).toBe('http://localhost/runtime.v1.ImageService/ListImages');
      expect(router.paths.has('/runtime.v1.ImageService/ListImages')).toBe(true);

      const req: UniversalServerRequest = {
        method: 'POST',
        url: createMethodUrl('http://junk', CRI.ImageService.method.listImages),
        header: new Headers({ 'Content-Type': 'application/grpc' }),
        body: Readable.from(
          toBinary(CRI.ListImagesRequestSchema, {
            $typeName: 'runtime.v1.ListImagesRequest',
          })
        ),
        httpVersion: '1.1',
        signal: router.signal,
      };

      const res = await router.route(req);
      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
    });
  });
});
