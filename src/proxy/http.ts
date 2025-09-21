import { from, map, NEVER, Observable, of } from 'rxjs';
import { Response } from '../response';
import axios from 'axios';
import Stream from 'stream';
import { Routes } from '../routes';

export class HttpProxy extends Response {
  private constructor(
    private method: string,
    private url: URL,
    private headers: Record<string, string | string[]>,
    private body: Buffer,
    signal: AbortSignal
  ) {
    super(signal);
  }

  static fromLambda(
    routes: Routes,
    payload: string,
    signal: AbortSignal
  ): Observable<Response> {
    try {
      // TODO: DDB and S3 events
      const data = JSON.parse(payload) as Record<string, unknown>;

      let {
        version = 'unknown',
        routeKey,
        rawPath = '',
        rawQueryString = '',
        headers = {},
        requestContext = {},
        isBase64Encoded = false,
      } = data;

      let { http = {} } = requestContext as Record<string, unknown>;
      let { method } = http as Record<string, unknown>;

      if (version !== '2.0' || routeKey !== '$default' || !method) {
        throw new Error('Unknown version, routeKey, or method');
      }

      if (
        typeof method !== 'string' ||
        typeof rawPath !== 'string' ||
        typeof rawQueryString !== 'string'
      ) {
        throw new Error('Invalid method, rawPath, or rawQueryString');
      }

      const url = routes.intoURL(rawPath);
      if (!url) {
        throw new Error('No matching route');
      }

      if (rawQueryString) {
        url.search = new URLSearchParams(rawQueryString).toString();
      }

      const proxy = new HttpProxy(
        method,
        url,
        JSON.parse(JSON.stringify(headers || {})),
        isBase64Encoded
          ? Buffer.from((data.body as string) || '', 'base64')
          : Buffer.from((data.body as string) || ''),
        signal
      );

      return of(proxy);
    } catch {
      return NEVER;
    }
  }

  get httpsAgent(): unknown {
    // TODO
    return undefined;
  }

  get timeout(): number {
    // TODO
    return 5000;
  }

  override send(): Observable<this> {
    return from(
      axios.request<Stream>({
        responseType: 'stream',
        method: this.method,
        url: this.url.toString(),
        headers: this.headers,
        data: this.body,
        httpsAgent: this.httpsAgent,
        timeout: this.timeout,
        maxRedirects: 0,
        validateStatus: () => true,
        transformRequest: (req) => req,
        transformResponse: (res) => res,
        signal: this.signal,
      })
    ).pipe(
      map((response) => {
        this.prelude.statusCode = response.status;
        this.prelude.headers = response.headers;
        this.prelude.cookies = [];

        if (response.headers['set-cookie']) {
          const cookies = response.headers['set-cookie'];
          if (Array.isArray(cookies)) {
            this.prelude.cookies.push(...cookies);
          } else if (typeof cookies === 'string') {
            this.prelude.cookies.push(cookies);
          }
        }

        response.data.pipe(this.data);
        response.data.on('end', () => {
          this.data.end();
        });

        return this;
      })
    );
  }
}
