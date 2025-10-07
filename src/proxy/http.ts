import { from, map, Observable, of } from 'rxjs';
import { Pipeline, Proxy } from '../pipeline';
import { Readable } from 'stream';
import { log, Logger, Trace } from '../log';
import axios, { AxiosHeaders, isAxiosError } from 'axios';
import { Agent } from 'https';
import { URI } from '../routes';
import { HttpHeaders, HttpResponse } from '.';

export type Prelude = { statusCode: number; headers: Headers; cookies: string[] };

export abstract class HttpProxy<P extends Pipeline> extends Proxy<P, HttpResponse> {
  constructor(
    pipeline: P,
    public readonly method: string,
    public readonly uri: URI,
    public readonly headers: HttpHeaders,
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
  private invokeHttp(): Observable<HttpResponse> {
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
  }

  @Trace
  private invokeRowdy(): Observable<HttpResponse> {
    const response = new HttpResponse(
      404,
      HttpHeaders.from({
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

    if (this.uri.host === 'ready') {
      return of(response.withStatus(200).withData(Readable.from('ok')));
    }

    if (this.uri.host === 'health') {
      return from(this.pipeline.routes.health()).pipe(
        map((backends) => {
          const health = {
            backends,
            healthy: Object.values(backends).every((b) => b.healthy),
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
      return of(response.withStatus(Number(this.uri.port)));
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
