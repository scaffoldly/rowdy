import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { fromEvent, mergeMap, Observable, race, repeat, takeUntil, tap } from 'rxjs';
import { Routes } from './routes';
import { ILoggable, log, Logger, Trace } from './log';
import { Pipeline, Result } from './pipeline';
import { LambdaPipeline } from './aws/pipeline';
import packageJson from '../package.json';
import path from 'path';
import { HeartbeatPipeline } from './heartbeat';

export type Secrets = Record<string, string>;

export class Environment implements ILoggable {
  public readonly signal: AbortSignal = this.abort.signal;

  private _routes: Routes;
  private _env = process.env;

  constructor(
    private abort: AbortController,
    private log: Logger
  ) {
    const args = yargs(hideBin(process.argv))
      .option('debug', { type: 'boolean', default: false, description: 'Enable debug logging' })
      .option('trace', { type: 'boolean', default: false, description: 'Enable tracing' })
      .option('routes', {
        type: 'string',
        default: `file://${process.cwd()}${path.sep}routes.yaml`,
        description: 'Path or URL to routing rules (file:// or data:).',
      })
      .scriptName('rowdy')
      .env('ROWDY')
      .version(`${packageJson.name} v${packageJson.version} [${packageJson.repository.url}]`)
      .help('h')
      .alias('h', 'help')
      .parseSync();

    if (args.debug) {
      this.log = this.log.withDebugging();
    }

    if (args.trace) {
      this.log = this.log.withTracing();
    }

    this._routes = Routes.fromURL(args.routes);

    log.debug('Environment', { environment: this });
    log.info('\nStarted. Press Ctrl+C to exit.\n');
  }

  get routes(): Routes {
    return this._routes;
  }

  get env(): Record<string, string | undefined> {
    return this._env;
  }

  @Trace
  public poll(): Observable<Result<Pipeline>> {
    return race([
      // Heartbeat wil keep the Observable alive
      new HeartbeatPipeline(this).every(30_000),
      new LambdaPipeline(this).into(),
    ]).pipe(
      takeUntil(fromEvent(this.signal, 'abort')),
      tap((request) => log.info('Request', { request })),
      mergeMap((request) => request.into()),
      tap((proxy) => log.debug('Proxy', { proxy })),
      mergeMap((proxy) => proxy.into()),
      tap((response) => log.debug('Respond', { response })),
      mergeMap((response) => response.into()),
      tap((result) => log.info('Result', { result })),
      repeat()
    );
  }

  protected withSecrets(secrets: Secrets): this {
    this._env = { ...this._env, ...secrets };
    return this;
  }

  repr(): string {
    return `Environment(routes=${Logger.asPrimitive(this._routes)})`;
  }
}
