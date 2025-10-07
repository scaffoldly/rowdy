import { fromEvent, mergeMap, Observable, race, repeat, takeUntil, tap } from 'rxjs';
import { Routes, IRoutes } from './routes';
import { log, Trace } from './log';
import { Pipeline, Result } from './pipeline';
import { LambdaPipeline } from './aws/pipeline';

export type Secrets = Record<string, string>;

export class Environment {
  public readonly abort = new AbortController();
  public readonly signal: AbortSignal = this.abort.signal;

  constructor() {}

  private _routes: Routes = Routes.fromDataURL(); // TODO: make fromEnvironment
  private _env = process.env;

  get routes(): Routes {
    return this._routes;
  }

  get env(): Record<string, string | undefined> {
    return this._env;
  }

  @Trace
  public poll(): Observable<Result<Pipeline>> {
    return race([new LambdaPipeline(this).into()]).pipe(
      takeUntil(fromEvent(this.signal, 'abort')),
      tap((request) => log.info('Requesting', { request })),
      mergeMap((request) => request.into()),
      tap((proxy) => log.info('Proxying', { proxy })),
      mergeMap((proxy) => proxy.into()),
      tap((response) => log.info('Responding', { response })),
      mergeMap((response) => response.into()),
      tap((result) => log.info('Result', { result })),
      repeat()
    );
  }

  protected withRoutes(routes?: IRoutes | string): this {
    if (!routes) {
      return this;
    }

    if (typeof routes === 'string') {
      this._routes = Routes.fromDataURL(routes);
      return this;
    }

    this._routes.withRules(routes.rules);
    return this;
  }

  protected withSecrets(secrets: Secrets): this {
    this._env = { ...this._env, ...secrets };
    return this;
  }
}
