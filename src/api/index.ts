import { from, Observable, of } from 'rxjs';
import { Pipeline } from '../pipeline';
import { HttpProxy } from '../proxy/http';
import { match } from 'path-to-regexp';
import { Logger } from '../log';
import axios, { AxiosInstance } from 'axios';
import { authenticator } from '../util/axios';
import { ImageApi } from './image';
import { ApiResponseStatus, ApiSchema, Health, IImageApi, IRegistryApi, Registry } from './types';
import { Environment } from '../environment';
import { RegistryApi } from './registry';
// import { RoutePaths } from '../routes';
import { GrpcResponse } from '@scaffoldly/rowdy-grpc';
import { Readable } from 'stream';

export class Rowdy {
  static readonly SLUG = '@rowdy';
  static readonly ERROR = 'error';
  static readonly HTTP = 'http';
  static readonly API = 'api';
  static readonly CRI = 'cri';
  static readonly HEALTH = 'health';
  static readonly PING = 'ping';
  static readonly ROUTES = 'routes';

  static readonly PATHS = {
    CRI: `/${Rowdy.SLUG}/${Rowdy.CRI}`,
  };

  public readonly http: AxiosInstance = axios.create();

  private _images: IImageApi = new ImageApi(this);
  private _registry: IRegistryApi = new RegistryApi(this);
  private _proxy?: HttpProxy<Pipeline>;

  constructor(
    public readonly log: Logger,
    public readonly signal: AbortSignal
  ) {
    const auth = authenticator(this.http, this.log);
    this.http.interceptors.request.use(...auth.request);
    this.http.interceptors.response.use(...auth.response);
  }

  get Images(): IImageApi {
    return this._images;
  }

  get Registry(): IRegistryApi {
    return this._registry;
  }

  get proxy(): HttpProxy<Pipeline> | undefined {
    return this._proxy;
  }

  get environment(): Environment | undefined {
    return this.proxy?.pipeline.environment;
  }

  // TODO: Implement https://github.com/kubernetes/cri-api/blob/v0.33.1/pkg/apis/runtime/v1/api.proto
  public readonly routes = {
    GET: [
      {
        match: match<Health['req']>('/health'),
        handler: this.health.bind(this),
      },
      // {
      //   match: match<Image['Req']>('/images/*image'),
      //   handler: this._images.getImage.bind(this.Images),
      // },
      {
        match: match<Registry['Req']>('/registry'),
        handler: this._registry.getRegistry.bind(this.Registry),
      },
    ],
    PUT: [
      // {
      //   match: match<Image['Req']>('/images/*image'),
      //   handler: this._images.putImage.bind(this.Images),
      // },
    ],
  };

  withProxy(proxy: HttpProxy<Pipeline>): this {
    this._proxy = proxy;
    this.http.defaults.headers.common['User-Agent'] = proxy.headers.userAgent;
    return this;
  }

  health(): Observable<ApiSchema<Health['res'], ApiResponseStatus>> {
    return of({
      apiVersion: 'rowdy.run/v1alpha1',
      kind: 'Health',
      spec: { healthy: true },
      status: {
        code: 200,
      },
    });
  }

  public cri(proxy: HttpProxy<Pipeline>): Observable<GrpcResponse> {
    return from(
      proxy.pipeline.cri.route(
        {
          url: proxy.source.uri.toString(),
          method: proxy.method,
          header: proxy.headers.intoHeaders(),
          body: Readable.from(proxy.body),
          signal: proxy.signal,
          httpVersion: '1.1',
        },
        Rowdy.PATHS.CRI
      )
    );
  }

  // public api(): Observable<ApiSchema<unknown, ApiResponseStatus>> {
  //   const { method, body, uri } = this.proxy || {};
  //   if (!method || !body || !uri) {
  //     this.log.warn('Missing method, body, or uri in proxy', { method, body, uri });
  //     return this.badRequest('Missing method, body, or uri in proxy');
  //   }

  //   const handlers = this.routes[method.toUpperCase() as keyof typeof this.routes];
  //   if (!handlers) {
  //     this.log.warn(`No handlers for method: ${method}`);
  //     return this.notFound(`No handlers for method: ${method}`);
  //   }

  //   const { pathname: path, searchParams } = uri;
  //   // TODO: handle encoding? or does body.toString() already do that
  //   // TODO: type checking and opts validation
  //   let opts = { ...Object.fromEntries(searchParams), ...(body.length ? JSON.parse(body.toString()) : {}) };

  //   const handler = handlers.reduce(
  //     (acc, { match: matcher, handler }) => {
  //       if (acc) return acc;
  //       const matchers = Array.isArray(matcher) ? matcher : [matcher];
  //       const matches = matchers.map((m) => m(path)).find((m) => m !== false);
  //       if (!matches) return acc;
  //       return handler(matches.params, opts);
  //     },
  //     undefined as Observable<ApiSchema<unknown, ApiResponseStatus>> | undefined
  //   );

  //   if (!handler) {
  //     this.log.warn(`No handler found for ${method} ${path}`);
  //     return this.notFound(`No handler found for ${method} ${path}`);
  //   }

  //   return handler;
  // }

  // private notFound(reason: string): Observable<ApiSchema<undefined, ApiResponseStatus>> {
  //   return of({
  //     apiVersion: 'rowdy.run/v1alpha1',
  //     kind: 'NotFound',
  //     spec: undefined,
  //     status: {
  //       code: 404,
  //       reason,
  //     },
  //   });
  // }

  // private badRequest(reason: string): Observable<ApiSchema<undefined, ApiResponseStatus>> {
  //   return of({
  //     apiVersion: 'rowdy.run/v1alpha1',
  //     kind: 'BadRequest',
  //     spec: undefined,
  //     status: {
  //       code: 400,
  //       reason,
  //     },
  //   });
  // }
}
