import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  catchError,
  defer,
  EMPTY,
  fromEvent,
  map,
  mergeMap,
  Observable,
  of,
  race,
  repeat,
  ReplaySubject,
  Subscription,
  switchMap,
  takeUntil,
  tap,
  timer,
} from 'rxjs';
import { Routes } from './routes';
import { ILoggable, isLevel, Level, log, Logger, mask, maskEnv, maskJson, Trace } from './log';
import { ShellProxy, ShellRequest } from './proxy/shell';
import { ShellPipeline } from './shell/pipeline';
import { Pipeline, Result } from './pipeline';
import { LambdaPipeline } from './aws/lambda';
import packageJson from '../package.json';
import { ABORT, Rowdy } from '.';
import { isatty } from 'tty';
import { LambdaFunction } from './aws/lambda/index';
import {
  applyVfs,
  LINUX_ERRNO,
  LocalAdapter,
  P9Server,
  S3Adapter,
  VfsAdapter,
  VFS_BACKING,
  VFS_SOCKET,
  wire,
} from '@scaffoldly/rowdy-vfs';
import { Volume } from './routes';
import { LambdaImageService } from './aws/lambda/image';
import { cpus } from 'os';
import { internalIpV4Sync } from 'internal-ip';
import { writeGithubOutput } from './util/github';

export type { Secrets } from './secrets';
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
    workdir: string | undefined;
  } & {
    volumes: string | undefined;
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
    workdir: string | undefined;
  } & {
    volumes: string | undefined;
  }
> => {
  const modified = argv
    .option('routes', {
      type: 'string',
      description: 'Path to, or inline YAML/JSON of, a Routes manifest (also accepts file:// and data:).',
      global: false,
      group: 'Entrypoint:',
    })
    .option('registry', {
      type: 'string',
      description: 'Image registry to use for pushing and serving images.',
      global: false,
      group: 'Entrypoint:',
    })
    .option('workdir', {
      type: 'string',
      description: 'Directory to run the command in. Stays in the current directory if it cannot be entered.',
      global: false,
      group: 'Entrypoint:',
    })
    .option('volumes', {
      type: 'string',
      description: 'Volumes to add to the Routes manifest: a YAML list, or one per line',
      global: false,
      group: 'Entrypoint:',
    });
  return modified;
};

export type ProcessEnv = Record<
  | 'HTTP_HOST'
  | 'HTTP_HOSTNAME'
  | 'HTTP_PROTO'
  | 'HTTP_UA'
  | 'NET_PRIVATE_IPV4'
  | 'ROWDY_VFS'
  | 'LD_PRELOAD'
  | 'VFS_PREFIX'
  | 'VFS_BACKING'
  | 'VFS_SOCKET'
  | 'VFS_MOUNTS',
  string | undefined
>;

export class Environment implements ILoggable {
  private static _CONCURRENCY = {
    MIN: 1,
    MAX: 10,
    CURRENT: 0,
  };

  static get CONCURRENCY(): number {
    if (Environment._CONCURRENCY.CURRENT === 0) {
      const num = cpus()?.length || Environment._CONCURRENCY.MIN;
      // Use all of the possible CPUs, up to MAX
      Environment._CONCURRENCY.CURRENT = Math.min(
        Math.max(Environment._CONCURRENCY.MIN, num),
        Environment._CONCURRENCY.MAX
      );
    }
    return Environment._CONCURRENCY.CURRENT;
  }

  public abort: AbortController = ABORT;
  public readonly signal: AbortSignal = this.abort.signal;
  public readonly bin = Object.keys(packageJson.bin)[0];

  private _pipelines: Pipeline[] = [new LambdaPipeline(this)];
  private _subscriptions: Subscription[] = [];
  private _routes: Routes;
  private _command?: string[] | undefined;
  private _envVars = new ReplaySubject<{ name: keyof ProcessEnv; value: ProcessEnv[keyof ProcessEnv] }>();
  private _rowdy: Rowdy;
  private _port?: number;
  private _registry: string | undefined;
  private _vfs?: Promise<P9Server>;

  constructor(public readonly log: Logger) {
    this.signal.addEventListener('abort', () => {
      this.log.debug(`Aborting environment: ${this.signal.reason}`);
      this._subscriptions.forEach((s) => s.unsubscribe());
      this._pipelines = [];
    });
    this._rowdy = new Rowdy(this.log, this.signal);
    this._routes = Routes.default();
    this.withEnv('HTTP_HOST', 'localhost')
      .withEnv('HTTP_HOSTNAME', 'localhost')
      .withEnv('HTTP_PROTO', 'http')
      .withEnv('HTTP_UA', `${packageJson.name}/${packageJson.version}`)
      .withEnv('NET_PRIVATE_IPV4', internalIpV4Sync());

    const parsed = yargs(hideBin(process.argv))
      .parserConfiguration({ 'populate--': true, 'boolean-negation': true })
      .scriptName(this.bin!)
      .env(this.bin!.toUpperCase())
      .version(packageJson.version)
      // DEVNOTE: No `choices`: this also arrives as ROWDY_LOG_LEVEL, and a bad value in a deployed
      // function's environment must fall back to the default rather than fail startup.
      .option('log-level', {
        type: 'string',
        description: 'Log verbosity: error, warn, info, debug or trace (default: info)',
        group: 'Logging:',
      })
      .option('debug', {
        type: 'boolean',
        default: false,
        description: 'Alias for --log-level debug',
        group: 'Logging:',
      })
      .option('trace', {
        type: 'boolean',
        default: false,
        description: 'Alias for --log-level trace',
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
            .option('cri', {
              type: 'boolean',
              description: 'Enable the CRI service',
              default: false,
              group: 'Runtime:',
            })
            .option('routes', {
              type: 'string',
              description: 'Path to, or inline YAML/JSON of, a Routes manifest (also accepts file:// and data:)',
              group: 'Runtime:',
            })
            .option('secrets', {
              type: 'string',
              description: 'Secrets: NAME=value lines and JSON objects, in any mix; NAME=value lines win',
              group: 'Runtime:',
            })
            .option('volumes', {
              type: 'string',
              description: 'Volumes to add to the Routes manifest: a YAML list, or one per line',
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

                    // DEVNOTE: The function's environment is merged on update, so the legacy flags
                    // are written explicitly: a function once deployed at debug must not stay there.
                    const level = Environment.levelOf(argv);
                    lambda = lambda
                      .withEnvironment('ROWDY_LOG_LEVEL', level)
                      .withEnvironment('ROWDY_DEBUG', `${level === 'debug' || level === 'trace'}`)
                      .withEnvironment('ROWDY_TRACE', `${level === 'trace'}`);
                    if (argv.command) {
                      lambda = lambda.withCommand(argv.command);
                    }
                    if (argv.name) {
                      lambda = lambda.withName(argv.name);
                    }
                    if (argv.memory) {
                      lambda = lambda.withMemory(argv.memory);
                    }
                    if (argv.cri) {
                      lambda = lambda.withCRI();
                    }
                    if (argv.routes) {
                      lambda = lambda.withRoutes(Routes.fromURL(argv.routes));
                    }
                    if (argv.volumes) {
                      lambda = lambda.withRoutes(Routes.empty().withVolumes(Volume.list(argv.volumes)));
                    }
                    if (argv.secrets) {
                      lambda = lambda.withSecrets(argv.secrets);
                    }

                    // TODO: URL True/False
                    // TODO: Stdin/Stdout/Stderr

                    this._subscriptions.push(
                      lambda.observe().subscribe({
                        next: (fn) => this.log.info('State Updated', Environment.flat(fn.State)),
                        error: (error: Error) => {
                          this.log.error('Lambda Function Installation Failed', {
                            name: error.name,
                            error: error.message,
                          });
                          process.exitCode = 1;
                          this.abort.abort('Installation failed');
                        },
                        complete: () => {
                          this.log.info('Lambda Function Installation Complete');
                          writeGithubOutput('url', lambda.State.FunctionUrl);
                        },
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

    // An explicit level wins; the boolean flags only ever raise verbosity.
    if (isLevel(parsed.logLevel?.toLowerCase())) {
      this.log.withLevel(parsed.logLevel.toLowerCase() as Level);
    } else if (parsed.trace) {
      this.log.withTracing();
    } else if (parsed.debug) {
      this.log.withDebugging();
    }

    log.info('Rowdy Started', { version: packageJson.version });
    log.debug(`Arguments parsed`, { parsed: maskJson(parsed), env: maskEnv(process.env) });

    if (isatty(process.stdout.fd)) {
      log.info('Press Ctrl+C to exit.');
    }
  }

  private setup(argv: Partial<Args>): void {
    if (argv.workdir) {
      this.chdir(argv.workdir);
    }
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
    if (argv.volumes) {
      this._routes.withVolumes(Volume.list(argv.volumes));
    }
  }

  private chdir(workdir: string): void {
    try {
      process.chdir(workdir);
    } catch (error) {
      this.log.warn('Working Directory Unavailable', {
        workdir,
        cwd: process.cwd(),
        uid: process.getuid?.(),
        error: (error as { code?: string }).code ?? `${error}`,
        reason: 'not enterable by this user; Lambda does not run as the image USER',
      });
    }
  }

  get name(): string {
    return packageJson.name;
  }

  get version(): string {
    return packageJson.version;
  }

  get userAgent(): string {
    return `${this.name}/${this.version}`;
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

  get debug(): boolean {
    return this.log.isDebugging;
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
          this.log.info('gRPC Server Initialized', { by: name });
        })
    );

    if (this.command && this.command.length) {
      log.info('Starting Command', { argv: this.command });

      this._subscriptions.push(
        new ShellProxy(shell, new ShellRequest(shell, this.command).withInput(process.stdin))
          .background()
          .invoke()
          .subscribe((response) => {
            this._subscriptions.push(
              response.subscribe({
                complete: () => {
                  log.info('Command Completed', { bin: response.bin, response });
                  if (this._port) {
                    // TODO: Clean up CTRL+C
                    return;
                  }
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

  @Trace(log)
  public poll(): Observable<Result<Pipeline>> {
    let delay = 0;

    const pipeline = defer(() =>
      race(this._pipelines.map((p) => p.into())).pipe(
        tap(() => (delay = 0)),
        catchError((err) => {
          delay = delay ? Math.min(delay * 2, 1000) : 100;
          log.warn('Pipeline Error', { error: `${err}`, retryIn: `${delay} ms` });
          return EMPTY;
        })
      )
    );

    return pipeline.pipe(
      takeUntil(fromEvent(this.signal, 'abort')),
      tap((request) => {
        log.info('Request', request.brief());
        log.debug('Request Detail', { request, routes: this.routes });
      }),
      mergeMap((request) => request.into().pipe(tap(() => this._envVars.complete())), Environment.CONCURRENCY),
      tap((proxy) => log.debug('Proxy', { proxy })),
      mergeMap((proxy) => proxy.into(), Environment.CONCURRENCY),
      tap((response) => log.debug('Respond', { response })),
      mergeMap((response) => response.into(), Environment.CONCURRENCY),
      tap((result) => log.info('Result', result.brief())),
      repeat({ delay: () => timer(delay) })
    );
  }

  repr(): string {
    return `Environment(routes=${Logger.asPrimitive(this._routes)})`;
  }

  /** The level a set of CLI flags asks for: `--log-level`, else the `--trace` / `--debug` aliases. */
  static levelOf(argv: { logLevel?: string; debug?: boolean; trace?: boolean }): Level {
    const explicit = argv.logLevel?.toLowerCase();
    if (isLevel(explicit)) {
      return explicit;
    }
    return argv.trace ? 'trace' : argv.debug ? 'debug' : 'info';
  }

  withEnv(name: keyof ProcessEnv, value: ProcessEnv[keyof ProcessEnv]): this {
    this.log.debug(`Received environment variable`, { name, value: mask(value) });
    this._envVars.next({ name, value });
    return this;
  }

  // Log fields from a plain object: primitives as they are, bigints as digits, anything else as
  // JSON (with bigints inside it as digits too). Logging must never throw.
  private static flat(fields: Record<string, unknown> = {}): Record<string, string | number | boolean> {
    const json = (value: unknown): string => {
      try {
        return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? '';
      } catch (e) {
        return `<unloggable: ${e instanceof Error ? e.message : String(e)}>`;
      }
    };
    return Object.fromEntries(
      Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [
          key,
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? value
            : typeof value === 'bigint'
              ? value.toString()
              : json(value),
        ])
    );
  }

  /** The store behind a volume: a local directory is the whole store; a bucket is synced into it. */
  private vfsAdapter(volume: Volume, backing: string): VfsAdapter {
    if (volume.scheme === 's3') {
      const [bucket, ...rest] = volume.locator.split('/');
      return new S3Adapter({
        bucket: bucket!,
        prefix: rest.join('/') || undefined,
        mountpoint: volume.mountpoint,
        lockOnOpen: volume.options.lock,
        localOnly: volume.options.local,
        owner: process.env.AWS_LAMBDA_LOG_STREAM_NAME,
        backing,
        log: (message, params) => this.log.child('vfs').debug(message, Environment.flat(params)),
        trace: (message, params) => this.log.child('vfs').trace(message, Environment.flat(params)),
      });
    }
    return new LocalAdapter();
  }

  /**
   * The VFS supervisor the preloaded shim reports to over a unix-domain socket
   * (protocol: @scaffoldly/rowdy-vfs DISCLOSURE). Started once per process on
   * first use, for the first declared volume, and closed on abort.
   */
  private vfsServer(mounts: Array<{ volume: Volume; backing: string }>): Promise<P9Server> {
    if (!this._vfs) {
      const names = Object.fromEntries(Object.entries(wire.T).map(([name, type]) => [type, name]));
      const server = new P9Server(
        mounts.map(({ volume, backing }) => ({
          mountpoint: volume.mountpoint,
          backing,
          adapter: this.vfsAdapter(volume, backing),
        })),
        {
          socket: VFS_SOCKET,
          // A miss before a create and a contended lock are how the protocol says "not yet".
          onRequest: ({ type, tag: _tag, ...request }, mount, ecode) => {
            const expected = ecode === undefined || ecode === LINUX_ERRNO.ENOENT || ecode === LINUX_ERRNO.EAGAIN;
            this.log.child('vfs')[expected ? 'debug' : 'warn'](names[type] ?? `T${type}`, {
              ...(mount ? { mount } : {}),
              ...Environment.flat({ ...request, ...('names' in request ? { names: request.names.join('/') } : {}) }),
              ...(ecode === undefined ? {} : { ecode }),
            });
          },
        }
      );
      this.signal.addEventListener('abort', () => {
        // Give leases back before the socket goes away so other instances are not held up until TTL.
        const released = Promise.all(
          server.mounts.map(({ adapter }) => (adapter instanceof S3Adapter ? adapter.releaseAll() : Promise.resolve()))
        );
        released
          .catch((err) => this.log.debug(`VFS lease release failed`, { error: `${err}` }))
          .then(() => server.close())
          .catch((err) => this.log.debug(`VFS supervisor close failed`, { error: `${err}` }));
      });
      this._vfs = server.listen().then((s) => {
        this.log.debug(`VFS supervisor listening`, { socket: s.socket });
        return s;
      });
    }
    return this._vfs;
  }

  get Env(): Observable<ProcessEnv> {
    return new Observable<ProcessEnv>((subscriber) => {
      const env: ProcessEnv = { ...process.env } as ProcessEnv;
      const subscription = this._envVars.subscribe({
        next: ({ name, value }) => {
          env[name] = value;
        },
        error: (err) => subscriber.error(err),
        complete: async () => {
          // Userspace VFS, opted into by declaring `volumes:` in the Routes manifest: the shim
          // is materialized and prepended to the child's LD_PRELOAD, and the supervisor socket
          // it reports to is started here. Child env only; rowdy's own process is never
          // preloaded. ROWDY_VFS is the shim's own switch, set here, not an operator knob.
          try {
            const volumes = this._routes.intoVolumes();
            if (volumes.length) {
              // file:// is served straight from its directory; anything else is materialized
              // into a directory of its own on the function's /tmp (siblings, never nested).
              const mounts = volumes.map((volume, i) => ({
                volume,
                backing: volume.scheme === 'file' ? volume.locator : i ? `${VFS_BACKING}.${i}` : VFS_BACKING,
              }));
              env.ROWDY_VFS = '1';
              const { socket } = await this.vfsServer(mounts);
              const vfs = applyVfs(env, {
                socket,
                mounts: mounts.map(({ volume, backing }) => ({ prefix: volume.mountpoint, backing })),
              });
              this.log.child('vfs').debug('Enabled For Child', {
                volumes: volumes.map((v) => v.spec).join(', '),
                mounts: env.VFS_MOUNTS,
                preload: vfs?.preload,
                socket: vfs?.socket,
              });
            }
          } catch (err) {
            subscriber.error(err);
            return;
          }
          this.log.debug(`Environment variables finalized`, { env: maskEnv(env) });
          subscriber.next({ ...env });
          subscriber.complete();
        },
      });

      return () => {
        subscription.unsubscribe();
      };
    });
  }
}
