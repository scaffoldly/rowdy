import { Environment, Logger } from '@scaffoldly/rowdy';
import { ShellExit, ShellProxy, ShellRequest, ShellResponse } from '../src/proxy/shell';
import { ShellPipeline } from '../src/shell/pipeline';
import { config, firstValueFrom, lastValueFrom, of, timeout } from 'rxjs';
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

describe('command exit', () => {
  // What rowdy did after the command exited: whether it shut down, the exit code it set, and the
  // codes it called process.exit with once the grace period passed.
  type Shutdown = {
    aborted: boolean;
    exitCode: typeof process.exitCode;
    exit: Array<Parameters<typeof process.exit>[0]>;
  };

  const exited = (status: ShellExit, port?: number): Shutdown => {
    const environment = new Environment(new Logger());
    environment.abort = new AbortController();
    environment['_port'] = port;
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    jest.useFakeTimers();
    try {
      environment['commandExited']('node', status);
      const aborted = environment.abort.signal.aborted;
      const exitCode = process.exitCode;
      jest.advanceTimersByTime(Environment.EXIT_GRACE_MS);
      return { aborted, exitCode, exit: exit.mock.calls.map(([code]) => code) };
    } finally {
      jest.useRealTimers();
      exit.mockRestore();
      process.exitCode = undefined;
    }
  };

  it('shuts rowdy down with the code when the command crashes, before the next request', () => {
    expect(exited({ code: 139, signal: 'SIGSEGV' })).toEqual({ aborted: true, exitCode: 139, exit: [139] });
  });

  it('shuts rowdy down with the code when the command exits non-zero', () => {
    expect(exited({ code: 3 })).toEqual({ aborted: true, exitCode: 3, exit: [3] });
  });

  it('shuts rowdy down cleanly when the command exits zero', () => {
    expect(exited({ code: 0 })).toEqual({ aborted: true, exitCode: undefined, exit: [] });
  });

  it('keeps serving with a gRPC port', () => {
    expect(exited({ code: 139, signal: 'SIGSEGV' }, 50051)).toEqual({ aborted: false, exitCode: undefined, exit: [] });
  });

  it('lets the requests in flight answer before shutting down', () => {
    const environment = new Environment(new Logger());
    environment.abort = new AbortController();
    environment['_inflight'] = 1;
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    jest.useFakeTimers();
    try {
      environment['commandExited']('node', { code: 139, signal: 'SIGSEGV' });
      jest.advanceTimersByTime(Environment.EXIT_GRACE_MS);
      expect(environment.abort.signal.aborted).toBe(false);
      expect(exit).not.toHaveBeenCalled();

      environment['_inflight'] = 0;
      environment['drained']();
      expect(environment.abort.signal.aborted).toBe(true);
      jest.advanceTimersByTime(Environment.EXIT_GRACE_MS);
      expect(exit.mock.calls).toEqual([[139]]);
    } finally {
      jest.useRealTimers();
      exit.mockRestore();
      process.exitCode = undefined;
    }
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
