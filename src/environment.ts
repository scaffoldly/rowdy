import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { fromEvent, map, mergeMap, Observable, of, race, repeat, Subscription, switchMap, takeUntil, tap } from 'rxjs';
import { Routes } from './routes';
import { ILoggable, log, Logger, Trace } from './log';
import { ShellProxy, ShellRequest } from './proxy/shell';
import { ShellPipeline } from './shell/pipeline';
import { Pipeline, Result } from './pipeline';
import { LambdaPipeline } from './aws/lambda';
import packageJson from '../package.json';
import { ABORT, Rowdy } from '.';
import { isatty } from 'tty';
import { LambdaFunction } from './aws/lambda/index';
import { LambdaImageService } from './aws/lambda/image';
import { inspect } from 'util';

export type Secrets = Record<string, string>;
type Args = yargs.ArgumentsCamelCase<
  {
    debug: boolean;
  } & {
    trace: boolean;
  } & {
    routes: string | undefined;
  } & {
    registry: string | undefined;
  } & {
    port: number | undefined;
  } & {
    'keep-alive': boolean;
  }
>;

const entrypoint = <T>(
  argv: yargs.Argv<T>
): yargs.Argv<
  T & {
    routes: string | undefined;
  } & {
    registry: string | undefined;
  } & {
    'keep-alive': boolean;
  }
> => {
  const modified = argv
    .option('routes', {
      type: 'string',
      description: 'Path or URL to routing rules (file:// or data:).',
      global: false,
      group: 'Entrypoint:',
    })
    .option('registry', {
      type: 'string',
      description: 'Image registry to use for pushing and serving images.',
      global: false,
      group: 'Entrypoint:',
    })
    .option('keep-alive', {
      type: 'boolean',
      default: false,
      description: 'Keep the process alive after command completion.',
      global: false,
      group: 'Entrypoint:',
    });

  return modified;
};

export class Environment implements ILoggable {
  public abort: AbortController = ABORT;
  public readonly signal: AbortSignal = this.abort.signal;
  public readonly bin = Object.keys(packageJson.bin)[0];

  private _pipelines: Pipeline[] = [new LambdaPipeline(this)];
  private _subscriptions: Subscription[] = [];
  private _routes: Routes;
  private _command?: string[] | undefined;
  private _env = process.env;
  private _rowdy: Rowdy;
  private _port?: number;
  private _registry: string | undefined;
  private _keepAlive: boolean = false;

  constructor(public readonly log: Logger) {
    this.signal.addEventListener('abort', () => {
      this.log.debug(`Aborting environment: ${this.signal.reason}`);
      this._subscriptions.forEach((s) => s.unsubscribe());
      this._pipelines = [];
    });
    this._rowdy = new Rowdy(this.log, this.signal);
    this._routes = Routes.default();

    const parsed = yargs(hideBin(process.argv))
      .parserConfiguration({ 'populate--': true, 'boolean-negation': true })
      .scriptName(this.bin!)
      .env(this.bin!.toUpperCase())
      .version(packageJson.version)
      .strict()
      .option('debug', {
        type: 'boolean',
        default: false,
        description: 'Enable debug logging',
        group: 'Logging:',
      })
      .option('trace', {
        type: 'boolean',
        default: false,
        description: 'Enable trace logging',
        group: 'Logging:',
      })
      .command({
        command: '$0',
        describe: 'Start Rowdy as a Docker Entrypoint',
        builder: (yargs) => entrypoint(yargs).usage('$0 [options] -- <command> [args...]'),
        handler: (argv: Partial<Args>) => this.setup(argv),
      })
      .command({
        command: 'serve',
        describe: 'Start Rowdy as a Docker Entrypoint and the Rowdy gRPC server',
        builder: (yargs) =>
          entrypoint(
            yargs
              .option('port', {
                type: 'number',
                default: 7939,
                description: 'Port to listen on',
                global: false,
                group: 'Server:',
              })
              .usage('$0 serve [options] -- <command> [args...]')
          ),
        handler: (argv: Partial<Args>) => this.setup(argv),
      })
      // TODO: Re-add 'install' command
      .command({
        command: 'create [options]',
        describe: 'Create a new Rowdy container',
        handler: (_argv: Partial<Args>) => {},
        builder: (yargs) =>
          yargs
            .option('name', {
              describe: 'The name of the container',
              type: 'string',
              group: 'Runtime:',
            })
            .option('memory', {
              describe: 'Memory limit in megabytes',
              default: 256,
              type: 'number',
              group: 'Runtime:',
            })
            .option('routes', {
              type: 'string',
              description: 'Route definitions (file:// or data:)',
              group: 'Runtime:',
            })
            .demandCommand(1, 'Please specify a subcommand')
            .command({
              command: 'aws',
              describe: 'Create a new Rowdy container in AWS',
              handler: (_argv: Partial<Args>) => {},
              builder: (yargs) =>
                yargs.demandCommand(1, 'Please specify a subcommand').command({
                  command: 'lambda <image> [command...]',
                  describe: 'Create a new Rowdy container in AWS Lambda',
                  builder: (yargs) =>
                    yargs
                      .parserConfiguration({ 'unknown-options-as-args': true })
                      .positional('image', {
                        describe: 'Container image to deploy',
                        type: 'string',
                        demandOption: true,
                      })
                      .positional('command', {
                        describe: 'Command to run in the container',
                        type: 'string',
                        array: true,
                      }),
                  handler: (argv) => {
                    // TODO: Fix logging ability in these early handlers
                    let lambda = new LambdaFunction(
                      'Container',
                      new LambdaImageService(this).withLayersFrom('ghcr.io/scaffoldly/rowdy:beta')
                    ).withImage(argv.image);

                    if (argv.debug) {
                      lambda = lambda.withEnvironment('ROWDY_DEBUG', 'true');
                    }
                    if (argv.trace) {
                      lambda = lambda.withEnvironment('ROWDY_TRACE', 'true');
                    }
                    if (argv.command) {
                      lambda = lambda.withCommand(argv.command);
                    }
                    if (argv.name) {
                      lambda = lambda.withName(argv.name);
                    }
                    if (argv.memory) {
                      lambda = lambda.withMemory(argv.memory);
                    }
                    if (argv.routes) {
                      const routes = Routes.fromURL(argv.routes);
                      lambda = lambda.withRoutes(routes);
                    }

                    // TODO: URL True/False
                    // TODO: Enable CRI
                    // TODO: Stdin/Stdout/Stderr
                    // TODO: Infer entrypoint from image
                    // TODO: Infer command from image

                    this._subscriptions.push(
                      lambda.observe(this.abort.signal).subscribe({
                        next: (fn) => this.log.info(`State Updated: ${inspect(fn.State)}`),
                        complete: () => this.log.info('Lambda Function Installation Complete'),
                      })
                    );
                  },
                }),
            }),
      })
      // .command({
      //   command: 'aws',
      //   describe: 'AWS utilities',
      //   handler: (_argv: Partial<Args>) => {},
      //   builder: (yargs) =>
      //     yargs.demandCommand(1, 'Please specify a subcommand').command({
      //       command: 'lambda',
      //       describe: 'AWS Lambda utilities',
      //       handler: (_argv: Partial<Args>) => {},
      //       builder: (yargs) =>
      //         yargs
      //           .demandCommand(1, 'Please specify a subcommand')
      //           .command({
      //             command: 'create <image> [command...]',
      //             describe: 'Create a new container in AWS Lambda',
      //             builder: (yargs) =>
      //               yargs
      //                 .parserConfiguration({ 'unknown-options-as-args': true })
      //                 .positional('image', {
      //                   describe: 'Container image to deploy',
      //                   type: 'string',
      //                   demandOption: true,
      //                 })
      //                 .positional('command', {
      //                   describe: 'Command and arguments to run in the container',
      //                   type: 'string',
      //                   array: true,
      //                 })
      //                 .option('name', {
      //                   describe: 'Assign a name to the Lambda function',
      //                   type: 'string',
      //                   group: 'Lambda:',
      //                 })
      //                 .option('memory', {
      //                   describe: 'Memory limit in megabytes',
      //                   default: 256,
      //                   type: 'number',
      //                   group: 'Container:',
      //                 })
      //                 .option('publish', {
      //                   alias: 'p',
      //                   description: "Publish a container's port(s) to the host",
      //                   type: 'number',
      //                   group: 'Container:',
      //                 }),
      //             handler: (argv) => {},
      //           })
      //           .command({
      //             command: 'install',
      //             describe: 'Install Rowdy to AWS Lambda',
      //             builder: (yargs) =>
      //               yargs
      //                 .option('name', {
      //                   type: 'string',
      //                   global: false,
      //                   description: 'Name of the Lambda function',
      //                   group: 'Lambda:',
      //                 })
      //                 .option('cri', {
      //                   type: 'boolean',
      //                   global: false,
      //                   description: 'Enable the CRI service',
      //                   default: true,
      //                   group: 'Lambda:',
      //                 })
      //                 .usage('$0 aws lambda install [options]'),
      //             handler: (argv) => {
      //               let lambda = new LambdaFunction('Container', new LambdaImageService(this))
      //                 .withMemory(1024)
      //                 .withCommand('sleep infinity')
      //                 .withEnvironment('ROWDY_DEBUG', `${argv.debug}`)
      //                 .withEnvironment('ROWDY_TRACE', `${argv.trace}`);

      //               if (argv.name) {
      //                 lambda = lambda.withName(argv.name);
      //               }

      //               if (argv.cri) {
      //                 lambda = lambda.withCRI();
      //               }

      //               this._subscriptions.push(
      //                 lambda.observe(this.abort.signal).subscribe({
      //                   next: (fn) => this.log.info(`State Updated: ${inspect(fn.State)}`),
      //                   complete: () => this.log.info('Lambda Function Installation Complete'),
      //                 })
      //               );
      //             },
      //           }),
      //     }),
      // })
      .help()
      .parseSync();

    if (parsed.debug) {
      this.log = this.log.withDebugging();
    }

    if (parsed.trace) {
      this.log = this.log.withTracing();
    }

    log.info(`${packageJson.name}@${packageJson.version} has started.`);
    log.debug(`Arguments parsed`, { parsed: JSON.stringify(parsed), env: JSON.stringify(process.env) });

    if (isatty(process.stdout.fd)) {
      log.info('Press Ctrl+C to exit.');
    }
  }

  private setup(argv: Partial<Args>): void {
    if (argv['--']) {
      this._command = argv['--'] as string[];
    }
    if (argv.port) {
      this._port = argv.port;
    }
    if (argv.registry) {
      this._registry = argv.registry;
    }
    if (argv.routes) {
      this._routes = Routes.fromURL(argv.routes);
    }
    if (argv['keep-alive']) {
      this._keepAlive = argv['keep-alive'];
    }
  }

  get name(): string {
    return packageJson.name;
  }

  get version(): string {
    return packageJson.version;
  }

  get rowdy(): Rowdy {
    return this._rowdy;
  }

  get registry(): string | undefined {
    return this._registry;
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

  get debug(): boolean {
    return this.log.isDebugging;
  }

  private get keepAlive(): boolean {
    return this._keepAlive;
  }

  public init(): this {
    const shell = new ShellPipeline(this);
    this._pipelines.push(shell);

    this._subscriptions.push(
      race(this._pipelines.map((p) => p.router.pipe(map((router) => ({ name: p.name, router })))))
        .pipe(
          switchMap(({ name, router }) => {
            if (!this._port) {
              return of({ name, router });
            }

            const { start, stop } = router.server(this._port);
            this.abort.signal.addEventListener('abort', () => {
              this.log.info('RPC server stopping', { port: this._port });
              stop();
            });
            this.log.info('gRPC server starting', { port: this._port });
            return start();
          })
        )
        .subscribe(({ name, router }) => {
          this._pipelines.forEach((p) => p.withRouter(router));
          this.log.info(`gRPC server initialized by ${name}`);
        })
    );

    if (this.command && this.command.length) {
      log.info(`Starting command`, { command: this.command });

      this._subscriptions.push(
        new ShellProxy(shell, new ShellRequest(shell, this.command).withInput(process.stdin))
          .background()
          .invoke()
          .subscribe((response) => {
            this._subscriptions.push(
              response.subscribe({
                complete: () => {
                  log.info(`'${response.bin}' completed`, { response });
                  if (!this.keepAlive) {
                    return;
                  }
                  // TODO: Clean up CTRL+C
                  response.fds.end();
                  this.abort.abort('Command complete');
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
