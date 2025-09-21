import {
  fromEvent,
  mergeMap,
  Observable,
  repeat,
  share,
  takeUntil,
} from 'rxjs';
import { Request } from './request';
import { Response } from './response';
import { Routes, TRoutes } from './routes';

export type Secrets = Record<string, string>;

export abstract class Environment {
  public readonly abort = new AbortController();
  public readonly signal: AbortSignal = this.abort.signal;
  public readonly aborted: Observable<Event> = fromEvent(
    this.abort.signal,
    'abort'
  ).pipe(share());

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

  protected withRoutes(routes?: TRoutes): this {
    if (!routes) {
      return this;
    }

    if (typeof routes === 'string') {
      // Try: JSON
      // TODO: Try: File Path (YAML or JSON)
      try {
        routes = JSON.parse(routes) as TRoutes;
      } catch (e) {
        throw new Error(
          `Failed to parse routes: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    this._routes = this._routes.with(routes);
    return this;
  }

  protected withSecrets(secrets: Secrets): this {
    this._env = { ...this._env, ...secrets };
    return this;
  }
}
