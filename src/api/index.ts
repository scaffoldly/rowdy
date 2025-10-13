import { Observable, of } from 'rxjs';
import { Pipeline } from '../pipeline';
import { HttpProxy } from '../proxy/http';
import { match } from 'path-to-regexp';
import { log } from '../log';

export type ApiVersion = 'rowdy.run/v1alpha1';
export type ApiKind = 'Routes' | 'Health' | 'Hello' | 'NotFound';
export type ApiSchema<Spec, Status> = {
  apiVersion: ApiVersion;
  kind: ApiKind;
  spec?: Spec;
  status: Status;
};

export type ApiResponseStatus = {
  code: number;
  headers: { [key: string]: string | string[] };
};

export type Health = {
  req: never;
  opts: never;
  res: { healthy: boolean };
};

export type Hello = {
  req: { to: string };
  opts: { enthusiastic?: boolean };
  res: { to: string };
};

export class Api {
  private routes = {
    GET: [
      {
        match: match<Health['req']>('/health'),
        handler: this.health.bind(this),
      },
      {
        match: match<Hello['req']>('/hello/:to'),
        handler: this.hello.bind(this),
      },
    ],
    POST: [
      {
        match: match<Hello['req']>('/hello/:to'),
        handler: this.hello.bind(this),
      },
    ],
  };

  constructor() {}

  health(): Observable<ApiSchema<Health['res'], ApiResponseStatus>> {
    return of({
      apiVersion: 'rowdy.run/v1alpha1',
      kind: 'Health',
      spec: { healthy: true },
      status: {
        code: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    });
  }

  hello(req: Hello['req'], opts?: Hello['opts']): Observable<ApiSchema<Hello['res'], ApiResponseStatus>> {
    const spec: Hello['res'] = { to: req.to };

    if (opts?.enthusiastic) {
      spec.to = spec.to.toUpperCase() + '!!!';
    }

    return of({
      apiVersion: 'rowdy.run/v1alpha1',
      kind: 'Hello',
      spec,
      status: {
        code: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    });
  }

  handle<P extends Pipeline>(proxy: HttpProxy<P>): Observable<ApiSchema<unknown, ApiResponseStatus>> {
    const handler = this.handler(proxy);

    if (!handler) {
      return of({
        apiVersion: 'rowdy.run/v1alpha1',
        kind: 'NotFound',
        status: {
          code: 404,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      });
    }

    return handler;
  }

  private handler<P extends Pipeline>(
    proxy: HttpProxy<P>
  ): Observable<ApiSchema<unknown, ApiResponseStatus>> | undefined {
    const { method, body } = proxy;
    const handlers = this.routes[method.toUpperCase() as keyof typeof this.routes];
    if (!handlers) {
      log.warn(`No handlers for method: ${method}`);
      return undefined;
    }

    const { pathname: path, searchParams } = proxy.uri;
    const opts = { ...Object.fromEntries(searchParams), ...JSON.parse(Buffer.from(body).toString()) };

    return handlers.reduce(
      (acc, { match: matcher, handler }) => {
        if (acc) return acc;
        const matches = matcher(path);
        if (!matches) return acc;
        return handler(matches.params, opts);
      },
      undefined as Observable<ApiSchema<unknown, ApiResponseStatus>> | undefined
    );
  }
}
