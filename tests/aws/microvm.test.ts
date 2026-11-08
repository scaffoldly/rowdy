import type { ChildProcess } from 'child_process';
import type { ExecaError, ExecaReturnValue, Options } from 'execa';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { mergeMap, Observable, Subscription } from 'rxjs';
import { Environment, Logger } from '../../src';
import {
  EXEC_ID_HEADER,
  EXEC_PATH,
  FILES_PATH,
  HOOKS_PORT,
  MicrovmPipeline,
  MicrovmRequest,
} from '../../src/aws/microvm';
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EXEC_CONTENT_TYPE, EXEC_STREAM, KILL_GRACE } from '../../src/proxy/shell';
import { Pipeline, Result } from '../../src/pipeline';

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
    const proc = spawn(file, args, { stdio: 'pipe', env: options.env, cwd: options.cwd, detached: options.detached });
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

describe('aws microvm pipeline', () => {
  const HOOKS = '/aws/lambda-microvms/runtime/v1';
  const ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:acme';
  const environment = new Environment(new Logger(), {});

  let subscription: Subscription | undefined;

  afterEach(() => {
    subscription?.unsubscribe();
    subscription = undefined;
    delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN;
  });

  const freePort = (): Promise<number> =>
    new Promise((resolve) => {
      const probe = createServer().listen(0, () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });

  // What Environment.poll does with a pipeline's requests.
  const answered = (pipeline: MicrovmPipeline): Observable<Result<Pipeline>> =>
    pipeline.into().pipe(
      mergeMap((request) => request.into()),
      mergeMap((proxy) => proxy.into()),
      mergeMap((response) => response.into())
    );

  const serve = async (results: Result<Pipeline>[] = []): Promise<string> => {
    const port = await freePort();
    process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = ARN;
    subscription = answered(new MicrovmPipeline(environment, port)).subscribe((result) => results.push(result));
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fetch(url).catch(() => undefined)) return url;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('hooks never listened');
  };

  describe('files', () => {
    const at = (url: string, path: string, mode?: string): string =>
      `${url}${FILES_PATH}?path=${encodeURIComponent(path)}${mode ? `&mode=${mode}` : ''}`;
    const dir = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'rowdy-files-')));

    it('writes bytes as they are, and reads them back', async () => {
      const url = await serve();
      const path = join(dir(), 'bin');
      const bytes = Buffer.from([0, 255, 10, 13, 128]);

      const put = await fetch(at(url, path), { method: 'PUT', body: bytes });
      const got = await fetch(at(url, path));

      expect(put.status).toBe(204);
      expect(readFileSync(path)).toEqual(bytes);
      expect(got.status).toBe(200);
      expect(Buffer.from(await got.arrayBuffer())).toEqual(bytes);
    });

    it("makes a file's missing directories, and sets its mode", async () => {
      const url = await serve();
      const path = join(dir(), 'a', 'b', 'run.sh');

      await fetch(at(url, path, '755'), { method: 'PUT', body: '#!/bin/sh' });

      expect(statSync(path).mode & 0o777).toBe(0o755);
    });

    it('takes a relative path from where a command starts', async () => {
      const url = await serve();
      const cwd = dir();
      const was = process.cwd();
      process.chdir(cwd);
      try {
        await fetch(at(url, 'rel.txt'), { method: 'PUT', body: 'hi' });
      } finally {
        process.chdir(was);
      }

      expect(readFileSync(join(cwd, 'rel.txt'), 'utf8')).toBe('hi');
    });

    it('answers 404 for a file that is not there', async () => {
      const url = await serve();

      expect((await fetch(at(url, join(dir(), 'missing')))).status).toBe(404);
    });

    it('makes a directory and its parents, and again without failing', async () => {
      const url = await serve();
      const path = join(dir(), 'x', 'y');

      const first = await fetch(at(url, path, '700'), { method: 'POST' });
      const again = await fetch(at(url, path), { method: 'POST' });

      expect([first.status, again.status]).toEqual([204, 204]);
      expect(statSync(path).isDirectory()).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o700);
    });

    it('says why it could not, as text', async () => {
      const url = await serve();
      const path = join(dir(), 'file');
      writeFileSync(path, 'x');

      const response = await fetch(at(url, join(path, 'under')), { method: 'PUT', body: 'y' });

      expect(response.status).toBe(500);
      expect(await response.text()).toMatch(/ENOTDIR|EEXIST/);
    });

    it.each([
      ['no path', (url: string) => `${url}${FILES_PATH}`],
      ['a mode that is not octal', (url: string) => at(url, '/tmp/x', '999')],
    ])('refuses %s', async (_, to) => {
      const url = await serve();

      expect((await fetch(to(url), { method: 'PUT', body: 'x' })).status).toBe(400);
    });

    it('refuses other methods', async () => {
      const url = await serve();

      expect((await fetch(at(url, '/tmp/x'), { method: 'DELETE' })).status).toBe(405);
    });
  });

  it.each(['ready', 'validate', 'run'])('answers the %s hook', async (hook) => {
    const url = await serve();

    const response = await fetch(`${url}${HOOKS}/${hook}`, {
      method: 'POST',
      body: JSON.stringify({ microvmId: 'mvm-1', runHookPayload: 'payload' }),
    });

    expect(response.status).toBe(200);
  });

  it('reports a hook as a result', async () => {
    const results: Result<Pipeline>[] = [];
    const url = await serve(results);
    results.length = 0;

    await fetch(`${url}${HOOKS}/ready`, { method: 'POST' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ success: true, status: 200 });
  });

  it('names the hook, and never the payload, in its logs', async () => {
    const requests: MicrovmRequest[] = [];
    const port = await freePort();
    process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = ARN;
    subscription = new MicrovmPipeline(environment, port).into().subscribe((request) => {
      requests.push(request as MicrovmRequest);
      (request as MicrovmRequest).res.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await fetch(`http://127.0.0.1:${port}${HOOKS}/run`, { method: 'POST', body: 'secret' });

    expect(requests[0]?.brief()).toEqual({ hook: 'run' });
    expect(requests[0]?.repr()).toBe('MicrovmRequest(hook=run)');
  });

  it('listens on the first ephemeral port by default', () => {
    expect(HOOKS_PORT).toBe(32768);
  });

  it.each([`${HOOKS}/suspend`, `${HOOKS}/terminate`, '/ready', '/'])('refuses %s', async (path) => {
    const url = await serve();

    const response = await fetch(`${url}${path}`, { method: 'POST' });

    expect(response.status).toBe(404);
  });

  describe('exec', () => {
    type Frame = { stream: number; payload: Buffer };

    beforeEach(() => environment['_envVars'].complete());

    const exec = (url: string, cmd: string, args: string[], spec = {}): Promise<Response> =>
      fetch(`${url}${EXEC_PATH}`, {
        method: 'POST',
        body: JSON.stringify({ apiVersion: 'rowdy.run/v1alpha1', kind: 'Exec', spec: { cmd, args, ...spec } }),
      });

    const frames = async (response: Response): Promise<Frame[]> => {
      let buffer = Buffer.from(await response.arrayBuffer());
      const decoded: Frame[] = [];
      while (buffer.length) {
        const size = buffer.readUInt32BE(4);
        decoded.push({ stream: buffer.readUInt8(0), payload: buffer.subarray(8, 8 + size) });
        buffer = buffer.subarray(8 + size);
      }
      return decoded;
    };

    const text = (mine: Frame[], stream: number): string =>
      Buffer.concat(mine.filter((frame) => frame.stream === stream).map(({ payload }) => payload)).toString();

    it('streams the frames of a command', async () => {
      const url = await serve();

      const response = await exec(url, 'sh', ['-c', 'echo out; echo err >&2']);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(EXEC_CONTENT_TYPE);
      expect(response.headers.get(EXEC_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
      const mine = await frames(response);
      expect(text(mine, EXEC_STREAM.STDOUT)).toBe('out\n');
      expect(text(mine, EXEC_STREAM.STDERR)).toBe('err\n');
      expect(JSON.parse(text(mine, EXEC_STREAM.EXIT))).toMatchObject({ code: 0 });
    });

    it('sends output as it happens', async () => {
      const url = await serve();

      const response = await exec(url, 'sh', ['-c', 'echo one; sleep 1; echo two']);
      const reader = response.body!.getReader();
      const started = Date.now();
      const { value } = await reader.read();

      expect(Buffer.from(value!).toString()).toContain('one');
      expect(Date.now() - started).toBeLessThan(800);
      await reader.cancel();
    });

    it('answers before a slow command prints anything', async () => {
      const url = await serve();
      const started = Date.now();

      const response = await exec(url, 'sh', ['-c', 'sleep 1']);

      expect(Date.now() - started).toBeLessThan(800);
      await response.arrayBuffer();
    });

    it('finishes as soon as the command does', async () => {
      const url = await serve();
      const started = Date.now();

      await (await exec(url, 'sh', ['-c', 'echo hi'])).arrayBuffer();

      expect(Date.now() - started).toBeLessThan(800);
    });

    it('ends with the exit', async () => {
      const url = await serve();

      const mine = await frames(await exec(url, 'sh', ['-c', 'echo a; echo b >&2; echo c']));

      expect(mine[mine.length - 1]?.stream).toBe(EXEC_STREAM.EXIT);
    });

    it('reports a failing command', async () => {
      const url = await serve();

      const mine = await frames(await exec(url, 'sh', ['-c', 'exit 3']));

      expect(JSON.parse(text(mine, EXEC_STREAM.EXIT))).toMatchObject({ code: 3 });
    });

    it('reports a command that cannot start', async () => {
      const url = await serve();

      const mine = await frames(await exec(url, '/no/such/binary', []));

      expect(JSON.parse(text(mine, EXEC_STREAM.EXIT)).code).toBe(127);
    });

    it('keeps binary output exact', async () => {
      const url = await serve();

      const mine = await frames(await exec(url, 'sh', ['-c', "printf '\\000\\377\\n\\001'"]));

      const out = mine.filter(({ stream }) => stream === EXEC_STREAM.STDOUT);
      expect(Buffer.concat(out.map(({ payload }) => payload))).toEqual(Buffer.from([0, 255, 10, 1]));
    });

    it('carries large output', async () => {
      const url = await serve();

      const mine = await frames(await exec(url, 'sh', ['-c', 'head -c 1000000 /dev/zero']));

      const out = mine.filter(({ stream }) => stream === EXEC_STREAM.STDOUT);
      expect(Buffer.concat(out.map(({ payload }) => payload))).toHaveLength(1000000);
    });

    it('runs two commands at once', async () => {
      const url = await serve();
      const started = Date.now();

      const [a, b] = await Promise.all([
        exec(url, 'sh', ['-c', 'sleep 1; echo a']).then(frames),
        exec(url, 'sh', ['-c', 'sleep 1; echo b']).then(frames),
      ]);

      expect(text(a, EXEC_STREAM.STDOUT)).toBe('a\n');
      expect(text(b, EXEC_STREAM.STDOUT)).toBe('b\n');
      expect(Date.now() - started).toBeLessThan(1800);
    });

    it('still answers hooks during a command', async () => {
      const url = await serve();
      const running = exec(url, 'sh', ['-c', 'sleep 1']);

      const hook = await fetch(`${url}${HOOKS}/ready`, { method: 'POST' });

      expect(hook.status).toBe(200);
      await (await running).arrayBuffer();
    });

    it('passes cwd and env', async () => {
      const url = await serve();

      const mine = await frames(await exec(url, 'sh', ['-c', 'pwd; echo $WHO'], { cwd: '/', env: { WHO: 'me' } }));

      expect(text(mine, EXEC_STREAM.STDOUT)).toBe('/\nme\n');
    });

    describe('a caller hanging up', () => {
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      const gone = async (pid: number): Promise<boolean> => {
        for (let attempt = 0; attempt < 200 && alive(pid); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return !alive(pid);
      };

      // Runs a script that prints a pid, reads it, then hangs up.
      const hangUp = async (url: string, script: string, detached?: boolean): Promise<number> => {
        const controller = new AbortController();
        const response = await fetch(`${url}${EXEC_PATH}`, {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            apiVersion: 'rowdy.run/v1alpha1',
            kind: 'Exec',
            spec: { cmd: 'sh', args: ['-c', script], detached },
          }),
        });
        const { value } = await response.body!.getReader().read();
        const pid = Number(Buffer.from(value!).subarray(8).toString().trim());
        controller.abort();
        return pid;
      };

      it('kills the command', async () => {
        const url = await serve();

        await expect(gone(await hangUp(url, 'echo $$; exec sleep 30'))).resolves.toBe(true);
      });

      it('leaves a detached command running', async () => {
        const url = await serve();

        const pid = await hangUp(url, 'echo $$; exec sleep 30', true);
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(alive(pid)).toBe(true);
        process.kill(pid, 'SIGKILL');
      });

      it('kills what the command started', async () => {
        const url = await serve();

        await expect(gone(await hangUp(url, 'sleep 30 & echo $!; wait'))).resolves.toBe(true);
      });

      it('kills a command that ignores SIGTERM', async () => {
        const timing = { ...KILL_GRACE };
        Object.assign(KILL_GRACE, { ms: 50 });
        const url = await serve();

        await expect(gone(await hangUp(url, "trap '' TERM; echo $$; while :; do sleep 1; done"))).resolves.toBe(true);
        Object.assign(KILL_GRACE, timing);
      });

      it('leaves a finished command alone', async () => {
        const kill = jest.spyOn(process, 'kill');
        const url = await serve();

        await frames(await exec(url, 'sh', ['-c', 'echo done']));
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(kill.mock.calls.filter(([pid]) => pid < 0)).toEqual([]);
      });
    });

    it('gives a command no input', async () => {
      const url = await serve();

      const mine = await frames(await exec(url, 'cat', []));

      expect(JSON.parse(text(mine, EXEC_STREAM.EXIT))).toMatchObject({ code: 0 });
    });

    it.each([
      ['not JSON', 'nope'],
      ['not an Exec event', '{"kind":"Cron"}'],
    ])('refuses a body that is %s', async (_, body) => {
      const url = await serve();

      const response = await fetch(`${url}${EXEC_PATH}`, { method: 'POST', body });

      expect(response.status).toBe(400);
    });

    it('never logs a command or its arguments', async () => {
      const requests: MicrovmRequest[] = [];
      const port = await freePort();
      process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = ARN;
      subscription = new MicrovmPipeline(environment, port).into().subscribe((request) => {
        requests.push(request as MicrovmRequest);
        (request as MicrovmRequest).res.end();
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await exec(`http://127.0.0.1:${port}`, 'sh', ['secret']);

      expect(requests[0]?.brief()).toEqual({ hook: 'exec' });
      expect(requests[0]?.repr()).toBe('MicrovmRequest(hook=exec)');
    });
  });

  it('stops listening when unsubscribed', async () => {
    const url = await serve();

    subscription?.unsubscribe();

    await expect(fetch(`${url}${HOOKS}/ready`, { method: 'POST' })).rejects.toThrow();
  });

  it('fails when the port is taken', async () => {
    const taken = createServer().listen(0);
    await new Promise((resolve) => taken.once('listening', resolve));
    process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = ARN;
    const { port } = taken.address() as AddressInfo;

    const error = new Promise((resolve) => {
      subscription = new MicrovmPipeline(environment, port).into().subscribe({ error: resolve });
    });

    await expect(error).resolves.toMatchObject({ code: 'EADDRINUSE' });
    taken.close();
  });

  it('stays out of the way outside a microVM', () => {
    const next = jest.fn();
    const listen = jest.spyOn(require('http').Server.prototype, 'listen');

    subscription = new MicrovmPipeline(environment).into().subscribe(next);

    expect(listen).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    listen.mockRestore();
  });

  it('runs alongside the other pipelines', () => {
    expect(environment['_pipelines'].some((p) => p instanceof MicrovmPipeline)).toBe(true);
  });
});
