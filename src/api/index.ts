import { Observable, of } from 'rxjs';
import { Pipeline } from '../pipeline';
import { HttpProxy } from '../proxy/http';
import { match } from 'path-to-regexp';
import { Logger } from '../log';
import axios, { AxiosInstance } from 'axios';
import { authenticate } from '../util/axios';
import { ImageApi } from './image';
import { ApiResponseStatus, ApiSchema, Health, IImageApi, Image, IRegistryApi, Registry } from './types';
import { Environment } from '../environment';
import { RegistryApi } from './registry';

export class Rowdy {
  public static readonly SLUG = '@rowdy';
  public readonly http: AxiosInstance = axios.create();

  private _images: IImageApi = new ImageApi(this);
  private _registry: IRegistryApi = new RegistryApi(this);
  private _proxy?: HttpProxy<Pipeline>;

  constructor(public readonly log: Logger) {
    this.http.interceptors.response.use(...authenticate(this.http, this.log));
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
      {
        match: match<Image['Req']>('/images/*image'),
        handler: this._images.getImage.bind(this.Images),
      },
      {
        match: match<Registry['Req']>('/registry'),
        handler: this._registry.getRegistry.bind(this.Registry),
      },
    ],
    PUT: [
      {
        match: match<Image['Req']>('/images/*image'),
        handler: this._images.putImage.bind(this.Images),
      },
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

  handle(): Observable<ApiSchema<unknown, ApiResponseStatus>> {
    const handler = this.handler();

    if (!handler) {
      return this.notFound('No matching route');
    }

    return handler;
  }

  private handler(): Observable<ApiSchema<unknown, ApiResponseStatus>> | undefined {
    const { method, body, uri } = this.proxy || {};
    if (!method || !body || !uri) {
      this.log.warn('Missing method, body, or uri in proxy', { method, body, uri });
      return undefined;
    }

    const handlers = this.routes[method.toUpperCase() as keyof typeof this.routes];
    if (!handlers) {
      this.log.warn(`No handlers for method: ${method}`);
      return undefined;
    }

    const { pathname: path, searchParams } = uri;
    // TODO: handle encoding? or does body.toString() already do that
    // TODO: type checking and opts validation
    let opts = { ...Object.fromEntries(searchParams), ...(body.length ? JSON.parse(body.toString()) : {}) };

    return handlers.reduce(
      (acc, { match: matcher, handler }) => {
        if (acc) return acc;
        const matchers = Array.isArray(matcher) ? matcher : [matcher];
        const matches = matchers.map((m) => m(path)).find((m) => m !== false);
        if (!matches) return acc;
        return handler(matches.params, opts);
      },
      undefined as Observable<ApiSchema<unknown, ApiResponseStatus>> | undefined
    );
  }

  private notFound(reason: string): Observable<ApiSchema<undefined, ApiResponseStatus>> {
    return of({
      apiVersion: 'rowdy.run/v1alpha1',
      kind: 'NotFound',
      spec: undefined,
      status: {
        code: 404,
        reason,
      },
    });
  }
}
