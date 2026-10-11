import { Environment, Logger } from '@scaffoldly/rowdy';
import { ExitContext, parseStatus, ShellExit, ShellProxy, ShellRequest, ShellResponse } from '../src/proxy/shell';
import { log } from '../src/log';
import { existsSync } from 'fs';
import { ShellPipeline } from '../src/shell/pipeline';
import {
  config,
  EMPTY,
  firstValueFrom,
  lastValueFrom,
  Observable,
  of,
  Subject,
  Subscription,
  take,
  timeout,
} from 'rxjs';
import { Pipeline, Proxy, Request } from '../src/pipeline';
import type { CRI } from '@scaffoldly/rowdy-grpc';
import { createServer, Server, AddressInfo } from 'net';
import { Routes } from '@scaffoldly/rowdy';
import { LambdaPipeline, LambdaRequest } from '../src/aws/lambda';
import { HttpProxy } from '../src/proxy/http';
import type { ChildProcess } from 'child_process';
import type { ExecaError, ExecaReturnValue, Options } from 'execa';

// execa is ESM-only, so stand in a spawn that settles the way execa does: it resolves on exit code 0
// and rejects with an ExecaError on a non-zero exit, a signal, or a failed spawn.
jest.mock('execa', () => {
  const { spawn } = jest.requireActual<typeof import('child_process')>('child_process');

  type MockExecaChildProcess = ChildProcess & Pick<Promise<ExecaReturnValue>, 'then' | 'catch'>;

  class MockExecaError extends Error implements ExecaError {
    readonly escapedCommand: string;
    // execa types exitCode as a number but leaves it undefined for a signal or a failed spawn.
    readonly exitCode!: number;
    readonly signal?: string;
    readonly originalMessage?: string;
    readonly stdout = '';
    readonly stderr = '';
    readonly failed = true;
    readonly timedOut = false;
    readonly killed = false;
    readonly isCanceled = false;
    readonly cwd = process.cwd();

    constructor(
      readonly shortMessage: string,
      readonly command: string,
      ended: Pick<ExecaError, 'signal' | 'originalMessage'> & { exitCode?: number }
    ) {
      super(shortMessage);
      this.escapedCommand = command;
      Object.assign(this, ended);
    }
  }

  const execa = (file: string, args: readonly string[], options: Options): MockExecaChildProcess => {
    const proc = spawn(file, args, { stdio: 'pipe', env: options.env, detached: options.detached });
    const command = [file, ...args].join(' ');
    const done = new Promise<ExecaReturnValue>((resolve, reject) => {
      proc.on('error', (error: NodeJS.ErrnoException) =>
        reject(
          new MockExecaError(`Command failed with ${error.code}: ${command}`, command, {
            originalMessage: error.message,
          })
        )
      );
      proc.on('exit', (exitCode, signal) => {
        if (signal) {
          return reject(new MockExecaError(`Command was killed with ${signal}: ${command}`, command, { signal }));
        }
        if (exitCode) {
          return reject(
            new MockExecaError(`Command failed with exit code ${exitCode}: ${command}`, command, { exitCode })
          );
        }
        const result: ExecaReturnValue = {
          command,
          escapedCommand: command,
          exitCode: 0,
          stdout: '',
          stderr: '',
          failed: false,
          timedOut: false,
          killed: false,
          isCanceled: false,
          cwd: process.cwd(),
        };
        resolve(result);
      });
    });
    return Object.assign(proc, { then: done.then.bind(done), catch: done.catch.bind(done) });
  };

  return { execa };
});

describe('shell', () => {
  const unhandled = jest.fn();

  beforeEach(() => {
    unhandled.mockReset();
    config.onUnhandledError = unhandled;
  });

  afterEach(() => {
    config.onUnhandledError = null;
  });

  const pipeline = (): ShellPipeline => {
    const environment = new Environment(new Logger());
    Object.defineProperty(environment, 'Env', { get: () => of({ ...process.env }) });
    return new ShellPipeline(environment);
  };

  const background = async (script: string): Promise<ShellResponse> => {
    const shell = pipeline();
    const proxy = new ShellProxy(shell, new ShellRequest(shell, [process.execPath, '-e', script])).background();
    return firstValueFrom(proxy.invoke().pipe(timeout(2000)));
  };

  const exit = (response: ShellResponse): Promise<ShellExit> => lastValueFrom(response.pipe(timeout(5000)));

  describe('background command', () => {
    it('hands back the response while the command is still running', async () => {
      const response = await background('setTimeout(() => {}, 1000)');
      let done = false;
      response.subscribe({ complete: () => (done = true) });
      expect(done).toBe(false);
      await expect(exit(response)).resolves.toEqual({ code: 0 });
    });

    it('reports a non-zero exit code without an unhandled error', async () => {
      const response = await background('setTimeout(() => process.exit(3), 50)');
      await expect(exit(response)).resolves.toEqual({
        code: 3,
        message: expect.stringMatching(/^Command failed with exit code 3: /),
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('reports a signal as 128 + its number without an unhandled error', async () => {
      const response = await background("setTimeout(() => process.kill(process.pid, 'SIGSEGV'), 50)");
      await expect(exit(response)).resolves.toEqual({
        code: 139,
        signal: 'SIGSEGV',
        message: expect.stringMatching(/^Command was killed with SIGSEGV: /),
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('keeps the last 20 lines of output for the exit report', async () => {
      const response = await background('for (let i = 0; i < 25; i++) console.log(`line ${i}`)');
      await exit(response);
      const { recent, uptimeMs } = response.context();
      expect(recent).toHaveLength(20);
      expect(recent[0]).toBe('stdout: line 5');
      expect(recent[19]).toBe('stdout: line 24');
      expect(uptimeMs).toBeGreaterThan(0);
    });

    (existsSync('/proc/self/status') ? it : it.skip)('samples memory and threads while the command runs', async () => {
      const response = await background('setTimeout(() => {}, 300)');
      await exit(response);
      expect(response.context().sample).toEqual({
        rssKb: expect.any(Number),
        threads: expect.any(Number),
        at: expect.any(Number),
      });
    });

    it('reports a command that cannot be started as 127', async () => {
      const shell = pipeline();
      const proxy = new ShellProxy(shell, new ShellRequest(shell, ['/nonexistent/rowdy-test-bin'])).background();
      const response = await firstValueFrom(proxy.invoke().pipe(timeout(2000)));
      await expect(exit(response)).resolves.toEqual({
        code: 127,
        message: 'Command failed with ENOENT: /nonexistent/rowdy-test-bin',
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).not.toHaveBeenCalled();
    });
  });
});

describe('process status', () => {
  it('reads VmRSS and Threads', () => {
    const status = 'Name:\tnode\nVmRSS:\t  204800 kB\nThreads:\t11\n';
    expect(parseStatus(status, 5)).toEqual({ rssKb: 204800, threads: 11, at: 5 });
  });

  it('is undefined without them', () => {
    expect(parseStatus('Name:\tnode\n', 5)).toBeUndefined();
  });
});

describe('command exit', () => {
  // A request the test finishes by completing it.
  class TestRequest extends Request<Pipeline> {
    readonly done = new Subject<Proxy<Pipeline, unknown>>();

    override into(): Observable<Proxy<Pipeline, unknown>> {
      return this.done;
    }

    override brief(): Record<string, string> {
      return { method: 'DELETE', path: '/tunnel' };
    }

    override repr(): string {
      return 'TestRequest()';
    }
  }

  // A pipeline that waits for the next request until the test hands one out.
  class TestPipeline extends Pipeline {
    private readonly next = new Subject<Request<Pipeline>>();
    fetches = 0;

    override get name(): string {
      return 'TestPipeline';
    }

    override into(): Observable<Request<Pipeline>> {
      this.fetches++;
      return this.next.pipe(take(1));
    }

    override version(): Observable<CRI.VersionResponse> {
      return EMPTY;
    }

    override repr(): string {
      return 'TestPipeline()';
    }

    receive(): TestRequest {
      const request = new TestRequest(this);
      this.next.next(request);
      return request;
    }
  }

  // process.exit never returns, so its stand-in throws; the timer that calls it surfaces the throw.
  class ProcessExit extends Error {
    constructor(readonly code: Parameters<typeof process.exit>[0]) {
      super(`process.exit(${code})`);
    }
  }

  type Harness = {
    environment: Environment;
    pipeline: TestPipeline;
    exit: jest.SpiedFunction<typeof process.exit>;
  };

  let rowdy: Harness;

  beforeEach(() => {
    jest.useFakeTimers();
    const environment = new Environment(new Logger());
    environment.abort = new AbortController();
    const pipeline = new TestPipeline(environment);
    environment['_pipelines'] = [pipeline];
    const exit = jest.spyOn(process, 'exit').mockImplementation((code): never => {
      throw new ProcessExit(code);
    });
    rowdy = { environment, pipeline, exit };
  });

  afterEach(() => {
    rowdy.exit.mockRestore();
    jest.useRealTimers();
    process.exitCode = undefined;
  });

  const start = (port?: number): Subscription => {
    rowdy.environment['_port'] = port;
    return rowdy.environment.poll().subscribe();
  };

  it('shuts down with the code when the command crashes while rowdy waits for a request', () => {
    start();
    rowdy.environment['commandExited']('node', { code: 139, signal: 'SIGSEGV' });
    expect(rowdy.environment.abort.signal.aborted).toBe(true);
    expect(process.exitCode).toBe(139);
    expect(() => jest.advanceTimersByTime(Environment.EXIT_GRACE_MS)).toThrow(new ProcessExit(139));
  });

  it('lets the request in flight answer, fetches no next one, then shuts down', () => {
    start();
    const request = rowdy.pipeline.receive();
    expect(rowdy.pipeline.fetches).toBe(1);

    rowdy.environment['commandExited']('node', { code: 3 });
    jest.advanceTimersByTime(Environment.EXIT_GRACE_MS);
    expect(rowdy.environment.abort.signal.aborted).toBe(false);
    expect(rowdy.exit).not.toHaveBeenCalled();

    request.done.complete();
    jest.advanceTimersByTime(0);
    expect(rowdy.pipeline.fetches).toBe(1);
    expect(rowdy.environment.abort.signal.aborted).toBe(true);
    expect(() => jest.advanceTimersByTime(Environment.EXIT_GRACE_MS)).toThrow(new ProcessExit(3));
  });

  it('logs what rowdy knew when the command crashed: uptime, memory, threads, last request, last output', () => {
    const error = jest.spyOn(log, 'error');
    start();
    rowdy.pipeline.receive();
    const context: ExitContext = {
      uptimeMs: 12345,
      sample: { rssKb: 204800, threads: 11, at: performance.now() },
      recent: ['stdout: ready', 'stderr: fetch failed'],
    };
    rowdy.environment['commandExited']('node', { code: 139, signal: 'SIGSEGV', message: 'killed' }, context);
    expect(error).toHaveBeenCalledWith(
      'Command Exited',
      expect.objectContaining({
        code: 139,
        signal: 'SIGSEGV',
        uptime: '12.3 s',
        rss: '200 MB',
        threads: 11,
        lastRequest: 'method=DELETE path=/tunnel',
      })
    );
    expect(error).toHaveBeenCalledWith('Command Output', { n: -1, line: 'stdout: ready' });
    expect(error).toHaveBeenCalledWith('Command Output', { n: 0, line: 'stderr: fetch failed' });
    error.mockRestore();
  });

  it('keeps fetching requests while the command runs', () => {
    start();
    rowdy.pipeline.receive().done.complete();
    jest.advanceTimersByTime(0);
    expect(rowdy.pipeline.fetches).toBe(2);
    expect(rowdy.environment.abort.signal.aborted).toBe(false);
  });

  it('shuts down cleanly when the command exits zero', () => {
    start();
    rowdy.environment['commandExited']('node', { code: 0 });
    expect(rowdy.environment.abort.signal.aborted).toBe(true);
    expect(process.exitCode).toBeUndefined();
    jest.advanceTimersByTime(Environment.EXIT_GRACE_MS);
    expect(rowdy.exit).not.toHaveBeenCalled();
  });

  it('keeps serving with a gRPC port', () => {
    start(50051);
    rowdy.environment['commandExited']('node', { code: 139, signal: 'SIGSEGV' });
    jest.advanceTimersByTime(Environment.EXIT_GRACE_MS);
    expect(rowdy.environment.abort.signal.aborted).toBe(false);
    expect(process.exitCode).toBeUndefined();
    expect(rowdy.exit).not.toHaveBeenCalled();
  });
});

describe('upstream dropped by a crashed command', () => {
  const MESSAGE = 'Command was killed with SIGSEGV (Segmentation fault): docker-entrypoint.sh node server.js';
  let server: Server;
  let port: number;

  beforeAll(async () => {
    // Accepts the connection (so the health check passes), then drops it when the request arrives.
    server = createServer((socket) => socket.on('data', () => socket.destroy()));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  type Answer = { status: number; body: string };

  const respond = async (exit?: ShellExit): Promise<Answer> => {
    const environment = new Environment(new Logger());
    environment['_routes'] = Routes.fromSchema({ default: `http://127.0.0.1:${port}/` });
    if (exit) {
      setTimeout(() => environment['_commandExit'].next(exit), 100);
    }
    const pipeline = new LambdaPipeline(environment);
    const event = {
      version: '2.0',
      routeKey: '$default',
      rawPath: '/tunnel',
      rawQueryString: '',
      headers: { host: 'example.com' },
      requestContext: { http: { method: 'DELETE' } },
      isBase64Encoded: false,
    };
    const request = new LambdaRequest(pipeline, JSON.stringify(event));
    const proxy = (await lastValueFrom(request['intoHttp']())) as HttpProxy<LambdaPipeline>;
    const response = await lastValueFrom(proxy.invoke());
    let body = '';
    for await (const chunk of response.data) body += chunk;
    return { status: response.status, body };
  };

  it("answers with the command's exit message", async () => {
    await expect(respond({ code: 139, signal: 'SIGSEGV', message: MESSAGE })).resolves.toEqual({
      status: 500,
      body: MESSAGE,
    });
  });

  it("fails a cron request with the command's exit message, for the log and the invocation error", async () => {
    const line = `*/15 * * * * DELETE http://127.0.0.1:${port}/tunnel`;
    const environment = new Environment(new Logger());
    environment.routes.withCrontab([line]);
    setTimeout(() => environment['_commandExit'].next({ code: 139, signal: 'SIGSEGV', message: MESSAGE }), 100);
    const pipeline = new LambdaPipeline(environment);
    const request = new LambdaRequest(
      pipeline,
      JSON.stringify({ apiVersion: 'rowdy.run/v1alpha1', kind: 'Cron', spec: { line } })
    );
    const proxy = (await lastValueFrom(request['intoHttp']())) as HttpProxy<LambdaPipeline>;
    const response = await lastValueFrom(proxy.into());
    await expect(lastValueFrom(response)).rejects.toThrow(
      `Cron request to http://127.0.0.1:${port}/tunnel failed with status 500: ${MESSAGE}`
    );
  });

  it('answers with the connection error when the command is still running', async () => {
    const { status, body } = await respond();
    expect(status).toBe(500);
    expect(body).toMatch(/socket hang up|ECONNRESET/);
  });
});
