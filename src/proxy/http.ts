import { from, map, Observable } from 'rxjs';
import { Pipeline, Proxy } from '../pipeline';
import { Readable } from 'stream';
import { ILoggable, log, Logger, Trace } from '../log';
import axios, { AxiosHeaders, AxiosResponseHeaders, isAxiosError } from 'axios';
import { Agent } from 'https';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { URI } from '../routes';

export type Prelude = { statusCode: number; headers: Headers; cookies: string[] };

export class HttpProxyHeaders implements ILoggable {
  private headers: Record<string, string | string[]> = {};
  private constructor() {}

  proxy(): HttpProxyHeaders {
    const instance = new HttpProxyHeaders();
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

  static fromAxios(axiosHeaders: Partial<AxiosHeaders | AxiosResponseHeaders>): HttpProxyHeaders {
    const instance = new HttpProxyHeaders();
    for (let [key, value] of Object.entries(axiosHeaders.toJSON?.() || {})) {
      if (!value) continue;
      if (Array.isArray(value)) {
        instance.headers[key.toLowerCase()] = value;
      }
      instance.headers[key.toLowerCase()] = String(value);
    }
    return instance;
  }

  static fromLambda(headers: Partial<APIGatewayProxyEventV2['headers']>): HttpProxyHeaders {
    const instance = new HttpProxyHeaders();
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

  repr(): string {
    return `Headers(keys=${Object.keys(this.headers)})`;
  }
}

export abstract class HttpProxy<P extends Pipeline> extends Proxy<P, HttpProxyResponse> {
  constructor(
    pipeline: P,
    public readonly method: string,
    public readonly uri: URI,
    public readonly headers: HttpProxyHeaders,
    public readonly body: Buffer
  ) {
    super(pipeline);
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
  override invoke(): Observable<HttpProxyResponse> {
    return from(
      axios
        .request<Readable>({
          responseType: 'stream',
          method: this.method,
          url: this.uri.toString(),
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
        return new HttpProxyResponse(
          response.status,
          HttpProxyHeaders.fromAxios(response.headers).proxy(),
          response.headers['set-cookie']
            ? Array.isArray(response.headers['set-cookie'])
              ? response.headers['set-cookie']
              : [response.headers['set-cookie']]
            : [],
          response.data
        );
      })
    );
  }

  override repr(): string {
    return `HttpProxy(method=${this.method}, url=${Logger.asPrimitive(this.uri)}, headers=${Logger.asPrimitive(this.headers)}, body=[${this.body.length} bytes])`;
  }
}

export class HttpProxyResponse implements ILoggable {
  constructor(
    public readonly statusCode: number,
    public readonly headers: HttpProxyHeaders,
    public readonly cookies: string[],
    public readonly data: Readable
  ) {}

  prelude(): { statusCode?: number; headers?: Record<string, unknown>; cookies?: string[] } {
    return {
      statusCode: this.statusCode,
      headers: this.headers.intoJSON(),
      cookies: this.cookies,
    };
  }

  repr(): string {
    return `HttpProxyResponse(statusCode=${Logger.asPrimitive(this.statusCode)}, headers=${Logger.asPrimitive(this.headers)}, cookies=${Logger.asPrimitive(this.cookies)} data=[stream])`;
  }
}
