import { from, Observable } from 'rxjs';
import { Pipeline } from '../pipeline';
import { HttpProxy } from '../proxy/http';
import { Logger } from '../log';
import axios, { AxiosInstance } from 'axios';
import { authenticator } from '../util/axios';
import { ImageApi } from './image';
import { IApi, IImageApi, TRegistry } from './types';
import { Environment } from '../environment';
// import { RoutePaths } from '../routes';
import { GrpcResponse } from '@scaffoldly/rowdy-grpc';
import { Readable } from 'stream';

export class Rowdy implements IApi {
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
  private _proxy?: HttpProxy<Pipeline>;

  constructor(
    public readonly log: Logger,
    public readonly signal: AbortSignal
  ) {
    const auth = authenticator(this.http, this.log);
    this.http.interceptors.request.use(...auth.request);
    this.http.interceptors.response.use(...auth.response);
  }

  get images(): IImageApi {
    return this._images;
  }

  get registry(): Observable<TRegistry> {
    return this.images.registry;
  }

  get proxy(): HttpProxy<Pipeline> | undefined {
    return this._proxy;
  }

  get environment(): Environment | undefined {
    return this.proxy?.pipeline.environment;
  }

  withProxy(proxy: HttpProxy<Pipeline>): this {
    this._proxy = proxy;
    this.http.defaults.headers.common['User-Agent'] = proxy.headers.userAgent;
    return this;
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
}
