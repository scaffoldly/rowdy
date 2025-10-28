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
import { DOMParser } from 'linkedom';
import docsHtml from '../static/docs.html';

export type GrpcRequest = UniversalServerRequest;
export type GrpcResponse = UniversalServerResponse;
export type Docs = Partial<OpenAPIV3_1.Document>;
export type Info = OpenAPIV3_1.InfoObject;

export abstract class GrpcService<D extends DescService, T> {
  private impl: Partial<ServiceImpl<D>> = {};
  private opts: Partial<UniversalHandlerOptions> = {};

  constructor(
    public readonly services: GrpcCollection<T>,
    public readonly service: D
  ) {}

  get implementation(): Partial<ServiceImpl<D>> {
    return this.impl;
  }

  get options(): Partial<UniversalHandlerOptions> {
    return this.opts;
  }

  with(impl: Partial<ServiceImpl<D>>): GrpcCollection<T> {
    this.impl = { ...this.impl, ...impl };
    return this.services;
  }

  withOptions(opts: Partial<UniversalHandlerOptions>): GrpcCollection<T> {
    this.opts = { ...this.opts, ...opts };
    return this.services;
  }
}

export abstract class GrpcCollection<T> {
  abstract get services(): GrpcService<DescService, T>[];
  abstract get docs(): Docs | undefined;

  and(): T {
    return this as unknown as T;
  }
}

export class GrpcRouter {
  private _services: GrpcService<DescService, unknown>[] = [];
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

  withServices(services: GrpcCollection<unknown>): this {
    for (const service of services.services) {
      this.withService(service);
    }

    this._docs.paths = {
      ...this._docs.paths,
      ...services.docs?.paths,
    };

    this._docs.components = {
      ...this._docs.components,
      ...services.docs?.components,
    };

    this._docs.tags = [...(this._docs.tags || []), ...(services.docs?.tags || [])];

    return this;
  }

  private withService<T extends DescService>(service: GrpcService<T, unknown>): this {
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

  async route(request: GrpcRequest): Promise<GrpcResponse> {
    const url = new URL(request.url);
    const incoming = url.pathname.toLowerCase();

    if (incoming === `${this._prefix}/`.toLowerCase()) {
      return this.index(request);
    }

    const handler = this._router.handlers.find((h) => incoming === `${this._prefix}${h.requestPath}`.toLowerCase());
    if (!handler) {
      return uResponseNotFound;
    }

    const response = await handler(request);
    return response;
  }

  async index(request: GrpcRequest | string): Promise<GrpcResponse> {
    const accept = typeof request === 'string' ? request : request.header.get('accept') || '';

    const negotiator = new Negotiator({ headers: { accept } });

    const acceptable = ['application/json', 'text/html'];
    const mediaTypes = negotiator.mediaTypes(acceptable);

    const docs = this._docs;
    docs.servers = [{ url: this._prefix }];

    const response = mediaTypes.reduce<GrpcResponse>(
      (acc, mediaType) => {
        if (acc.body) {
          return acc;
        }
        switch (mediaType) {
          case 'application/json':
            acc.status = 200;
            acc.header?.set('content-type', 'application/json; charset=utf-8');
            acc.body = Readable.from(JSON.stringify(docs, null, 2));
            return acc;
          case 'text/html':
            acc.status = 200;
            acc.header?.set('content-type', 'text/html; charset=utf-8');
            const dom = new DOMParser().parseFromString(docsHtml, 'text/html');
            dom.querySelector('title')!.textContent = docs.info?.title || NAME;
            dom
              .getElementById('elements')!
              .setAttribute(
                'apiDescriptionUrl',
                `data:application/json;base64,${Buffer.from(JSON.stringify(docs)).toString('base64')}`
              );
            acc.body = Readable.from(dom.toString());
            return acc;
          default:
            return acc;
        }
      },
      {
        status: 406,
        header: new Headers({
          'x-accept': accept,
          'x-acceptable': acceptable.join(', '),
          'content-type': 'text/plain; charset=utf-8',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': '*',
          'access-control-allow-headers': '*',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          expires: '0',
        }),
      }
    );

    return response;
  }
}
