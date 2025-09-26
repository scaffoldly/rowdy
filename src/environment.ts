import { fromEvent, mergeMap, Observable, repeat, share, takeUntil } from 'rxjs';
import { Request } from './request';
import { Response } from './response';
import { Routes, IRoutes } from './routes';

export type Secrets = Record<string, string>;

export abstract class Environment {
  public readonly abort = new AbortController();
  public readonly signal: AbortSignal = this.abort.signal;
  public readonly aborted: Observable<Event> = fromEvent(this.abort.signal, 'abort').pipe(share());

  private _routes: Routes = new Routes();
  private _env = process.env;

  constructor() {}

  get routes(): Routes {
    return this._routes;
  }

  public poll(): Observable<Response> {
    return new Observable<Response>((subscriber) => {
      const subscription = this.next()
        .pipe(repeat({ delay: 0 }), takeUntil(this.aborted))
        .pipe(mergeMap((request) => request.into()))
        .pipe(mergeMap((response) => response.send()))
        .subscribe(subscriber);

      return () => {
        subscription.unsubscribe();
      };
    });
  }

  public abstract next(): Observable<Request>;

  protected withRoutes(routes?: IRoutes | string): this {
    if (!routes) {
      return this;
    }

    if (typeof routes === 'string') {
      routes = Routes.fromDataURL(routes);
    }

    this._routes.withRules(routes.rules);
    return this;
  }

  protected withSecrets(secrets: Secrets): this {
    this._env = { ...this._env, ...secrets };
    return this;
  }
}
