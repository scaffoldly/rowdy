import {
  ConnectRouter,
  ConnectRouterOptions,
  createConnectRouter,
  createRouterTransport,
  ServiceImpl,
  Transport,
} from '@connectrpc/connect';
import {
  compressionBrotli,
  compressionGzip,
  connectNodeAdapter,
  createGrpcWebTransport,
} from '@connectrpc/connect-node';
import {
  UniversalHandlerOptions,
  UniversalServerRequest,
  UniversalServerResponse,
  uResponseNotFound,
} from '@connectrpc/connect/protocol';
import { DescService } from '@bufbuild/protobuf';
import { OpenAPIV3_1 } from 'openapi-types';
import Negotiator from 'negotiator';
import { NAME, VERSION } from '.';
import { Readable } from 'stream';
import { createServer } from 'http';

export type Request = UniversalServerRequest;
export type Response = UniversalServerResponse;
export type Docs = Partial<OpenAPIV3_1.Document>;
export type Info = OpenAPIV3_1.InfoObject;

export abstract class Service<D extends DescService, T> {
  private impl: Partial<ServiceImpl<D>> = {};
  private opts: Partial<UniversalHandlerOptions> = {};

  constructor(
    public readonly services: Services<T>,
    public readonly service: D
  ) {}

  get implementation(): Partial<ServiceImpl<D>> {
    return this.impl;
  }

  get options(): Partial<UniversalHandlerOptions> {
    return this.opts;
  }

  with(impl: Partial<ServiceImpl<D>>): Services<T> {
    this.impl = { ...this.impl, ...impl };
    return this.services;
  }

  withOptions(opts: Partial<UniversalHandlerOptions>): Services<T> {
    this.opts = { ...this.opts, ...opts };
    return this.services;
  }
}

export abstract class Services<T> {
  abstract get services(): Service<DescService, T>[];
  abstract get docs(): Docs;

  and(): T {
    return this as unknown as T;
  }
}

export class Router {
  private _services: Service<DescService, unknown>[] = [];
  private _router: ConnectRouter;
  private _docs: Docs;
  private _routerOptions: ConnectRouterOptions;
  private _prefix: string = '';

  constructor(
    public readonly signal: AbortSignal,
    info?: Info
  ) {
    const acceptCompression = [compressionGzip, compressionBrotli];

    this._routerOptions = {
      acceptCompression,
      grpc: true,
      grpcWeb: true,
      connect: true,
      shutdownSignal: signal,
    };

    this._router = createConnectRouter(this._routerOptions);

    this._docs = {
      openapi: '3.1.0',
      info: {
        ...info,
        title: info?.title || NAME,
        version: info?.version || VERSION,
      },
      paths: {},
      components: {},
      tags: [],
      security: [],
    };
  }

  get size(): number {
    return this._services.reduce((acc, service) => (acc += service.service.methods.length), 0);
  }

  get local(): Transport {
    return createRouterTransport((router) => {
      for (const service of this._services) {
        router.service(service.service, service.implementation, service.options);
      }
      return router;
    });
  }

  withPrefix(prefix: string): this {
    this._prefix = prefix;
    return this;
  }

  withServices(services: Services<unknown>): this {
    for (const service of services.services) {
      this.withService(service);
    }

    this._docs.paths = {
      ...this._docs.paths,
      ...services.docs.paths,
    };

    this._docs.components = {
      ...this._docs.components,
      ...services.docs.components,
    };

    this._docs.tags = [...(this._docs.tags || []), ...(services.docs.tags || [])];

    return this;
  }

  private withService<T extends DescService>(service: Service<T, unknown>): this {
    this._services.push(service);
    this._router.service(service.service, service.implementation, service.options);
    return this;
  }

  server(port?: number): { start: () => Promise<Transport>; stop: () => Promise<void> } {
    const abortController = new AbortController();
    this.signal.addEventListener('abort', () => {
      abortController.abort();
    });

    const server = createServer(
      connectNodeAdapter({
        routes: (router) => {
          for (const service of this._services) {
            router.service(service.service, service.implementation, service.options);
          }
          return router;
        },
        ...this._routerOptions,
      })
    );

    const start = (): Promise<Transport> => {
      return new Promise((resolve, reject) => {
        server.listen({ host: '::', port: port ? port : undefined }, () => {
          const address = server.address();
          if (!address || typeof address === 'string') {
            return reject(new Error('Failed to start server'));
          }

          const transport = createGrpcWebTransport({
            baseUrl: `http://localhost:${address.port}`,
            httpVersion: '1.1',
          });

          resolve(transport);
        });

        server.on('error', (err) => {
          reject(err);
        });
      });
    };

    const stop = (): Promise<void> => {
      return new Promise((resolve, reject) => {
        abortController.abort();
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    };

    return { start, stop };
  }

  async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return this.docs(request.header?.get('accept') || undefined);
    }

    const handler = this._router.handlers.find((h) => `${this._prefix}${h.requestPath}` === url.pathname);
    if (!handler) {
      return uResponseNotFound;
    }

    const response = await handler(request);
    return response;
  }

  public async docs(accept?: string): Promise<Response> {
    // TODO: server URL from Host/Authority Header
    const negotiator = new Negotiator({ headers: { accept: accept || undefined } });

    if (negotiator.mediaType(['application/json']) === 'application/json') {
      return {
        status: 200,
        header: new Headers({
          'Content-Type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': '*',
          'access-control-allow-headers': '*',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          expires: '0',
        }),
        body: Readable.from(JSON.stringify(this._docs, null, 2)),
      };
    }

    if (negotiator.mediaType(['text/html']) === 'text/html') {
      return {
        status: 200,
        header: new Headers({
          'Content-Type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          expires: '0',
        }),
        body: Readable.from('<h1>TODO</h1>'),
      };
    }

    return {
      status: 406,
      header: new Headers({
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        expires: '0',
      }),
      body: Readable.from('Not Acceptable'),
    };
  }
}
