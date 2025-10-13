import { from, map, Observable, of, switchMap } from 'rxjs';
import { Pipeline, Proxy, Request } from '../pipeline';
import { Readable } from 'stream';
import { ILoggable, log, Logger, Trace } from '../log';
import axios, { AxiosHeaders, AxiosResponseHeaders, isAxiosError } from 'axios';
import { Agent } from 'https';
import { URI } from '../routes';
import { APIGatewayProxyEventV2 } from 'aws-lambda';

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
  private invokeHttp(): Observable<HttpResponse> {
    return this.uri.await().pipe(
      switchMap((uri) => {
        return from(
          axios
            .request<Readable>({
              responseType: 'stream',
              method: this.method,
              url: uri.toString(),
              headers: this.headers.proxy().intoAxios(),
              data: this.body,
              httpsAgent: this.httpsAgent,
              timeout: 0,
              maxRedirects: 0,
              validateStatus: () => true,
              transformRequest: (req) => req,
              transformResponse: (res) => res,
              signal: this.signal,
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
            return new HttpResponse(
              response.status,
              HttpHeaders.fromAxios(response.headers).proxy(),
              response.headers['set-cookie']
                ? Array.isArray(response.headers['set-cookie'])
                  ? response.headers['set-cookie']
                  : [response.headers['set-cookie']]
                : [],
              response.data
            );
          })
        );
      })
    );
  }

  @Trace
  private invokeRowdy(): Observable<HttpResponse> {
    const response = new HttpResponse(
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
      }).proxy(),
      [],
      Readable.from('')
    );

    log.debug('Rowdy Proxy', { method: this.method, uri: Logger.asPrimitive(this.uri) });

    if (this.uri.host === 'error') {
      const reason = this.uri.error || 'Unknown error';
      const status = Number(this.uri.port) || 500;
      return of(response.withStatus(status).withHeader('x-reason', reason));
    }

    if (this.uri.host === 'routes') {
      const { routes } = this.pipeline;
      return of(
        response
          .withStatus(200)
          .withHeader('content-type', 'application/json; charset=utf-8')
          .withData(Readable.from(JSON.stringify(routes, null, 2)))
      );
    }

    if (this.uri.host === 'ping') {
      return of(response.withStatus(200).withData(Readable.from('pong')));
    }

    if (this.uri.host === 'health') {
      return from(this.pipeline.routes.health()).pipe(
        map((backends) => {
          const health = {
            backends,
            healthy: Object.values(backends).every((b) => b.status === 'ok' || b.status === 'unknown'),
            now: new Date().toISOString(),
          };
          return response
            .withStatus(200)
            .withHeader('content-type', 'application/json; charset=utf-8')
            .withData(Readable.from(JSON.stringify(health, null, 2)));
        })
      );
    }

    if (this.uri.host === 'http' && Number.isInteger(this.uri.port)) {
      return of(response.withHeader('x-error', this.uri.error).withStatus(Number(this.uri.port)));
    }

    if (this.uri.host === 'api') {
      return of(
        response
          .withStatus(200)
          .withHeader('content-type', 'application/json; charset=utf-8')
          .withData(Readable.from(JSON.stringify({})))
      );
    }

    return of(response);
  }

  @Trace
  override invoke(): Observable<HttpResponse> {
    if (this.uri.protocol === 'rowdy:') {
      return this.invokeRowdy();
    }
    return this.invokeHttp();
  }

  override repr(): string {
    return `HttpProxy(method=${this.method}, url=${Logger.asPrimitive(this.uri)}, headers=${Logger.asPrimitive(this.headers)}, body=[${this.body.length} bytes])`;
  }
}

export class HttpHeaders implements ILoggable {
  private headers: Record<string, string | string[]> = {};
  private constructor() {}

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

export class HttpResponse implements ILoggable {
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
    return this._headers;
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

  repr(): string {
    return `HttpProxyResponse(status=${Logger.asPrimitive(this.status)}, headers=${Logger.asPrimitive(this.headers)}, cookies=${Logger.asPrimitive(this.cookies)} data=[stream])`;
  }
}
