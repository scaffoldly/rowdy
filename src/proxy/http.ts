import { catchError, from, map, NEVER, Observable, of, race, switchMap } from 'rxjs';
import { Pipeline, Proxy, Request } from '../pipeline';
import { Readable } from 'stream';
import { ILoggable, log, Logger, Trace } from '../log';
import axios, { AxiosHeaders, AxiosResponseHeaders, isAxiosError } from 'axios';
import { Agent } from 'https';
import { URI } from '../routes';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Rowdy } from '../api';
import packageJson from '../../package.json';

export type Prelude = { statusCode: number; headers: Headers; cookies: string[] };

export abstract class HttpProxy<P extends Pipeline> extends Proxy<P, HttpResponse> {
  constructor(
    pipeline: P,
    request: Request<P>,
    public readonly method: string,
    public readonly uri: URI,
    public readonly headers: HttpHeaders,
    public readonly body: Buffer
  ) {
    super(pipeline, request);
  }

  get httpsAgent(): Agent | undefined {
    if (this.uri.insecure) {
      return new Agent({
        checkServerIdentity: () => undefined,
        rejectUnauthorized: false,
      });
    }
    return undefined;
  }

  @Trace
  override invoke(): Observable<HttpResponse> {
    return race([
      new LocalHttpResponse().handle(this),
      new RowdyHttpResponse(this.pipeline.log, this.pipeline.signal).handle(this),
    ]).pipe(catchError((error) => new RowdyHttpResponse(this.pipeline.log, this.pipeline.signal).catch(error)));
  }

  override repr(): string {
    return `HttpProxy(method=${this.method}, url=${Logger.asPrimitive(this.uri)}, headers=${Logger.asPrimitive(this.headers)}, body=[${this.body.length} bytes])`;
  }
}

export class HttpHeaders implements ILoggable {
  private headers: Record<string, string | string[]> = {};
  private constructor() {}

  get userAgent(): string {
    return (this.headers['user-agent'] as string) || `${packageJson.name}/${packageJson.version}`;
  }

  get(header: string): string | string[] | undefined {
    return this.headers[header.toLowerCase()];
  }

  proxy(): HttpHeaders {
    const instance = new HttpHeaders();
    instance.headers = { ...this.headers };

    delete instance.headers['set-cookie']; // cookies are handled separately

    if (this.headers['host']) {
      this.headers['x-forwarded-host'] = this.headers['host'];
      delete instance.headers['host'];
    }

    if (this.headers['connection']) {
      for (let key of this.headers['connection']
        .toString()
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())) {
        delete instance.headers[key];
      }
      delete instance.headers['connection'];
    }

    delete instance.headers['keep-alive'];
    delete instance.headers['proxy-authenticate'];
    delete instance.headers['proxy-authorization'];
    delete instance.headers['te'];
    delete instance.headers['trailer'];
    delete instance.headers['transfer-encoding'];
    delete instance.headers['upgrade'];

    // TODO: add x-forwarded-for
    // TODO: add via

    return instance;
  }

  static from(obj: Record<string, string | string[]>): HttpHeaders {
    const instance = new HttpHeaders();
    for (let [key, value] of Object.entries(obj || {})) {
      if (!value) continue;
      instance.headers[key.toLowerCase()] = value;
    }
    return instance;
  }

  static fromHeaders(headers: Headers): HttpHeaders {
    const instance = new HttpHeaders();
    for (let [key, value] of headers.entries()) {
      if (!value) continue;
      instance.headers[key.toLowerCase()] = value;
    }
    return instance;
  }

  static fromAxios(axiosHeaders: Partial<AxiosHeaders | AxiosResponseHeaders>): HttpHeaders {
    const instance = new HttpHeaders();
    for (let [key, value] of Object.entries(axiosHeaders.toJSON?.() || {})) {
      if (!value) continue;
      if (Array.isArray(value)) {
        instance.headers[key.toLowerCase()] = value;
      }
      instance.headers[key.toLowerCase()] = String(value);
    }
    return instance;
  }

  static fromLambda(headers: Partial<APIGatewayProxyEventV2['headers']>): HttpHeaders {
    const instance = new HttpHeaders();
    for (let [key, value] of Object.entries(headers || {})) {
      if (!value) continue;
      instance.headers[key.toLowerCase()] = String(value);
    }
    return instance;
  }

  intoAxios(): AxiosHeaders {
    const axiosHeaders = new AxiosHeaders();
    for (let [key, value] of Object.entries(this.headers)) {
      if (Array.isArray(value)) {
        for (let v of value) {
          axiosHeaders.append(key, v);
        }
      } else {
        axiosHeaders.set(key, value);
      }
    }
    return axiosHeaders;
  }

  intoJSON(): Record<string, unknown> {
    return this.intoAxios().toJSON();
  }

  intoHeaders(): Headers {
    const headers = new Headers();
    for (let [key, value] of Object.entries(this.headers)) {
      if (Array.isArray(value)) {
        for (let v of value) {
          headers.append(key, v);
        }
      } else {
        headers.set(key, value);
      }
    }
    return headers;
  }

  override(key: string, value?: string | string[]): this {
    if (!value) {
      delete this.headers[key.toLowerCase()];
      return this;
    }
    key = key.toLowerCase();
    this.headers[key] = value;
    return this;
  }

  repr(): string {
    return `Headers(keys=${Object.keys(this.headers)})`;
  }
}

export abstract class HttpResponse implements ILoggable {
  private _status: number;
  private _headers: HttpHeaders;
  private _cookies: string[];
  private _data: Readable;

  constructor(status: number, headers: HttpHeaders, cookies: string[], data: Readable) {
    this._status = status;
    this._headers = headers;
    this._cookies = cookies;
    this._data = data;
  }

  get status(): number {
    return this._status;
  }

  get headers(): HttpHeaders {
    return this._headers.proxy();
  }

  get cookies(): string[] {
    return this._cookies;
  }

  get data(): Readable {
    return this._data;
  }

  prelude(): { statusCode?: number; headers?: Record<string, unknown>; cookies?: string[] } {
    return {
      statusCode: this.status,
      headers: this.headers.intoJSON(),
      cookies: this.cookies,
    };
  }

  withStatus(code: number): this {
    this._status = code;
    return this;
  }

  withHeader(key: string, value?: string): this {
    this._headers.override(key, value);
    return this;
  }

  withHeaders(headers: HttpHeaders): this {
    this._headers = headers;
    return this;
  }

  withCookies(cookies: string[]): this {
    this._cookies = cookies;
    return this;
  }

  withData(data: Readable): this {
    // check if data is already being consumed, if it is, throw an error
    if (this.data.readableFlowing) {
      throw new Error('Cannot replace data stream that is already being consumed');
    }

    if (this.data.readableEnded) {
      throw new Error('Cannot replace data stream that has already ended');
    }

    this._data = data;
    return this;
  }

  abstract handle<P extends Pipeline>(proxy: HttpProxy<P>): Observable<HttpResponse>;
  abstract repr(): string;
}

class RowdyHttpResponse extends HttpResponse {
  private rowdy: Rowdy;

  constructor(
    private log: Logger,
    private signal: AbortSignal
  ) {
    super(
      404,
      HttpHeaders.from({
        // TODO: coerce content type based on accept header
        'content-type': 'text/plain; charset=utf-8',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': '*',
        'access-control-allow-headers': '*',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        expires: '0',
      }),
      [],
      Readable.from('')
    );

    this.rowdy = new Rowdy(this.log, this.signal);
  }

  catch(error: unknown): Observable<HttpResponse> {
    return of(
      this.withStatus(500)
        .withHeader('content-type', 'text/plain; charset=utf-8')
        .withData(Readable.from(String(error)))
    );
  }

  @Trace
  override handle<P extends Pipeline>(proxy: HttpProxy<P>): Observable<HttpResponse> {
    if (proxy.uri.protocol !== 'rowdy:') {
      return NEVER;
    }

    log.debug('Rowdy Proxy', { method: proxy.method, uri: Logger.asPrimitive(proxy.uri) });

    if (proxy.uri.host === Rowdy.ERROR) {
      const reason = proxy.uri.error || 'Unknown error';
      const status = Number(proxy.uri.port) || 500;
      return of(this.withStatus(status).withHeader('x-reason', reason));
    }

    if (proxy.uri.host === Rowdy.ROUTES) {
      const { routes } = proxy.pipeline;
      return of(
        this.withStatus(200)
          .withHeader('content-type', 'application/json; charset=utf-8')
          .withData(Readable.from(JSON.stringify(routes, null, 2)))
      );
    }

    if (proxy.uri.host === Rowdy.PING) {
      return of(this.withStatus(200).withData(Readable.from('pong')));
    }

    if (proxy.uri.host === Rowdy.HEALTH) {
      return from(proxy.pipeline.routes.health()).pipe(
        map((backends) => {
          const health = {
            backends,
            healthy: Object.values(backends).every((b) => b.status === 'ok' || b.status === 'unknown'),
            now: new Date().toISOString(),
          };
          return this.withStatus(200)
            .withHeader('content-type', 'application/json; charset=utf-8')
            .withData(Readable.from(JSON.stringify(health, null, 2)));
        })
      );
    }

    if (proxy.uri.host === Rowdy.HTTP && Number.isInteger(proxy.uri.port)) {
      return of(this.withHeader('x-error', proxy.uri.error).withStatus(Number(proxy.uri.port)));
    }

    if (proxy.uri.host === Rowdy.API) {
      return this.rowdy
        .withProxy(proxy)
        .api()
        .pipe(
          map((response) => {
            return this.withStatus(response.status.code)
              .withHeaders(HttpHeaders.from(response.status.headers || {}))
              .withHeader('content-type', 'application/json; charset=utf-8')
              .withData(Readable.from(JSON.stringify(response, null, 2)));
          })
        );
    }

    if (proxy.uri.host === Rowdy.CRI) {
      return this.rowdy.cri(proxy).pipe(
        map(({ status, body, header }) => {
          return this.withStatus(status)
            .withData(Readable.from(body || ''))
            .withHeaders(HttpHeaders.fromHeaders(header || new Headers()));
        })
      );
    }

    return of(this);
  }

  override repr(): string {
    return `RowdyHttpResponse(status=${this.status}, headers=${Logger.asPrimitive(this.headers)}, cookies=[${this.cookies.length} cookies], data=[${this.data.readableEnded ? 'ended' : this.data.readableFlowing ? 'flowing' : 'readable'}])`;
  }
}

class LocalHttpResponse extends HttpResponse {
  constructor() {
    super(404, HttpHeaders.from({}), [], Readable.from(''));
  }

  @Trace
  override handle<P extends Pipeline>(proxy: HttpProxy<P>): Observable<HttpResponse> {
    if (proxy.uri.protocol !== 'http:' && proxy.uri.protocol !== 'https:') {
      return NEVER;
    }

    log.debug('Local Http Proxy', { method: proxy.method, uri: Logger.asPrimitive(proxy.uri) });

    return proxy.uri.await().pipe(
      switchMap((uri) => {
        return from(
          axios
            .request<Readable>({
              responseType: 'stream',
              method: proxy.method,
              url: uri.toString(),
              headers: this.headers.proxy().intoAxios(),
              data: proxy.body,
              httpsAgent: proxy.httpsAgent,
              timeout: 0,
              maxRedirects: 0,
              validateStatus: () => true,
              transformRequest: (req) => req,
              transformResponse: (res) => res,
              signal: proxy.signal,
            })
            .catch((error) => {
              log.warn(`HttpProxy.into() Axios Error`, { error, isAxiosError: isAxiosError(error) });
              if (!isAxiosError<Readable>(error)) {
                throw new Error(`Non-HTTP error occurred: ${error instanceof Error ? error.message : String(error)}`);
              }
              if (!error.response) {
                log.debug('Creating an Axios Response', { error });
                error.response = {
                  data: Readable.from(error instanceof Error ? error.message : String(error)),
                  status: 500,
                  statusText: 'Internal Server Error',
                  headers: new AxiosHeaders({
                    'Content-Type': 'text/plain; charset=utf-8', // TODO: check accept header
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': '*',
                    'Access-Control-Allow-Headers': '*',
                  }),
                  config: { headers: new AxiosHeaders() }, // TODO: construct an Axios object?
                };
              }
              return error.response;
            })
        ).pipe(
          map((response) => {
            log.debug(`HttpProxy.invoke() response`, {
              status: response.status,
              headers: JSON.stringify(response.headers),
            });
            return this.withStatus(response.status)
              .withHeaders(HttpHeaders.fromAxios(response.headers))
              .withCookies(
                response.headers['set-cookie']
                  ? Array.isArray(response.headers['set-cookie'])
                    ? response.headers['set-cookie']
                    : [response.headers['set-cookie']]
                  : []
              )
              .withData(response.data);
          })
        );
      })
    );
  }

  override repr(): string {
    return `LocalHttpResponse(status=${this.status}, headers=${Logger.asPrimitive(this.headers)}, cookies=[${this.cookies.length} cookies], data=[${this.data.readableEnded ? 'ended' : this.data.readableFlowing ? 'flowing' : 'readable'}])`;
  }
}
