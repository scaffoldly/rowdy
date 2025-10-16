import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { fromEvent, mergeMap, Observable, race, repeat, Subscription, takeUntil, tap } from 'rxjs';
import { Routes } from './routes';
import { ILoggable, log, Logger, Trace } from './log';
import { ShellProxy, ShellRequest } from './proxy/shell';
import { ShellPipeline } from './shell/pipeline';
import { Pipeline, Result } from './pipeline';
import { LambdaPipeline } from './aws/lambda';
import packageJson from '../package.json';
import path from 'path';
import { isatty } from 'tty';
import { ABORT } from '.';

export type Secrets = Record<string, string>;

type Args = {
  debug: boolean;
  trace: boolean;
  routes: string;
  registry: string | undefined;
  '--'?: string[];
};

export class Environment implements ILoggable {
  public abort: AbortController = ABORT;
  public readonly signal: AbortSignal = this.abort.signal;
  public readonly bin = Object.keys(packageJson.bin)[0];

  private _pipelines: Pipeline[] = [new LambdaPipeline(this)];
  private subscriptions: Subscription[] = [];
  private _routes: Routes;
  private _command?: string[] | undefined;
  private _env = process.env;
  private _args: Args;

  constructor(public readonly log: Logger) {
    this.signal.addEventListener('abort', () => {
      this.log.debug(`Aborting environment: ${this.signal.reason}`);
      this.subscriptions.forEach((s) => s.unsubscribe());
      this._pipelines = [];
    });

    this._args = yargs(hideBin(process.argv))
      .parserConfiguration({ 'halt-at-non-option': true, 'populate--': true })
      .scriptName(this.bin!)
      .env(this.bin!.toUpperCase())
      .usage('$0 -- <command> [args...]')
      .strict()
      .version(packageJson.version)
      .help()
      .option('debug', { type: 'boolean', default: false, description: 'Enable debug logging' })
      .option('trace', { type: 'boolean', default: false, description: 'Enable tracing' })
      .option('routes', {
        type: 'string',
        default: `file://${process.cwd()}${path.sep}routes.yaml`,
        description: 'Path or URL to routing rules (file:// or data:).',
      })
      .option('registry', {
        type: 'string',
        description: 'Image registry to use for pushing and serving images.',
      })
      .parseSync();

    if (this._args.debug) {
      this.log = this.log.withDebugging();
    }

    if (this._args.trace) {
      this.log = this.log.withTracing();
    }

    this._command = this._args['--'];
    this._routes = Routes.fromURL(this._args.routes);

    log.debug('Environment', { environment: this });

    log.info(`${packageJson.name}@${packageJson.version} has started.`);

    if (isatty(process.stdout.fd)) {
      log.info('Press Ctrl+C to exit.');
    }
  }

  get opts(): Args {
    // Return a copy to prevent mutation
    const args = { ...this._args };
    delete args['--'];
    return args;
  }

  get routes(): Routes {
    return this._routes;
  }

  get command(): string[] | undefined {
    return this._command;
  }

  get env(): Record<string, string | undefined> {
    return this._env;
  }

  public init(): this {
    const pipeline = new ShellPipeline(this);
    this._pipelines.push(pipeline);

    if (this.command && this.command.length) {
      log.info(`Starting command`, { command: this.command });

      this.subscriptions.push(
        new ShellProxy(pipeline, new ShellRequest(pipeline, this.command).withInput(process.stdin))
          .background()
          .invoke()
          .subscribe((response) => {
            this.subscriptions.push(
              response.subscribe({
                complete: () => {
                  log.info(`'${response.bin}' completed`, { response });
                  this.abort.abort('Command complete');
                  response.fds.end();
                },
              })
            );
          })
      );
    }

    return this;
  }

  @Trace
  public poll(): Observable<Result<Pipeline>> {
    return race(this._pipelines.map((p) => p.into())).pipe(
      takeUntil(fromEvent(this.signal, 'abort')),
      tap((request) => log.info('Request', { request, routes: this.routes })),
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
