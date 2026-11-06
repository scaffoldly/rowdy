import type { ChildProcess } from 'child_process';
import type { ExecaError, ExecaReturnValue, Options } from 'execa';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { mergeMap, Observable, Subscription } from 'rxjs';
import { Environment, Logger } from '../../src';
import { EXEC_MARKER, EXEC_PATH, HOOKS_PORT, MicrovmPipeline, MicrovmRequest } from '../../src/aws/microvm';
import { EXEC_STREAM } from '../../src/proxy/shell';
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
    type Line = { cmdId: string; seq: number; stream: number; payload: Buffer };

    let written: string[];

    beforeEach(() => {
      environment['_envVars'].complete();
      written = [];
      const write = process.stdout.write.bind(process.stdout);
      jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: string, ...rest: never[]) => {
        if (`${chunk}`.startsWith(EXEC_MARKER)) {
          written.push(`${chunk}`);
          return true;
        }
        return write(chunk, ...rest);
      }) as never);
    });

    afterEach(() => jest.restoreAllMocks());

    const lines = (): Line[] =>
      written.map((line) => {
        const [marker, cmdId = '', seq = '', frame = ''] = line.trimEnd().split(' ');
        expect(marker).toBe(EXEC_MARKER);
        const bytes = Buffer.from(frame, 'base64');
        const payload = bytes.subarray(8);
        expect(bytes.readUInt32BE(4)).toBe(payload.length);
        return { cmdId, seq: Number(seq), stream: bytes.readUInt8(0), payload };
      });

    const exec = (url: string, cmd: string, args: string[], spec = {}): Promise<Response> =>
      fetch(`${url}${EXEC_PATH}`, {
        method: 'POST',
        body: JSON.stringify({ apiVersion: 'rowdy.run/v1alpha1', kind: 'Exec', spec: { cmd, args, ...spec } }),
      });

    const exited = async (cmdId?: string): Promise<Line[]> => {
      for (let attempt = 0; attempt < 500; attempt++) {
        const mine = lines().filter((line) => !cmdId || line.cmdId === cmdId);
        if (mine.some(({ stream }) => stream === EXEC_STREAM.EXIT)) return mine;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('command never exited');
    };

    const text = (mine: Line[], stream: number): string =>
      Buffer.concat(mine.filter((line) => line.stream === stream).map(({ payload }) => payload)).toString();

    it('answers at once with an id, and frames the output', async () => {
      const url = await serve();

      const response = await exec(url, 'sh', ['-c', 'echo out; echo err >&2']);
      const { cmdId } = (await response.json()) as { cmdId: string };

      expect(response.status).toBe(202);
      const mine = await exited(cmdId);
      expect(text(mine, EXEC_STREAM.STDOUT)).toBe('out\n');
      expect(text(mine, EXEC_STREAM.STDERR)).toBe('err\n');
      expect(JSON.parse(text(mine, EXEC_STREAM.EXIT))).toMatchObject({ code: 0 });
    });

    it('numbers every line of a command in order, across its streams', async () => {
      const url = await serve();

      await exec(url, 'sh', ['-c', 'echo a; echo b >&2; echo c']);

      const mine = await exited();
      expect(mine.map(({ seq }) => seq)).toEqual(mine.map((_, i) => i));
      expect(mine[mine.length - 1]?.stream).toBe(EXEC_STREAM.EXIT);
    });

    it('reports a failing command', async () => {
      const url = await serve();

      await exec(url, 'sh', ['-c', 'exit 3']);

      expect(JSON.parse(text(await exited(), EXEC_STREAM.EXIT))).toMatchObject({ code: 3 });
    });

    it('reports a command that cannot start', async () => {
      const url = await serve();

      await exec(url, '/no/such/binary', []);

      expect(JSON.parse(text(await exited(), EXEC_STREAM.EXIT)).code).toBe(127);
    });

    it('keeps binary output exact', async () => {
      const url = await serve();

      await exec(url, 'sh', ['-c', "printf '\\000\\377\\n\\001'"]);

      const out = (await exited()).filter(({ stream }) => stream === EXEC_STREAM.STDOUT);
      expect(Buffer.concat(out.map(({ payload }) => payload))).toEqual(Buffer.from([0, 255, 10, 1]));
    });

    it('splits large output across lines', async () => {
      const url = await serve();

      await exec(url, 'sh', ['-c', 'head -c 100000 /dev/zero']);

      const out = (await exited()).filter(({ stream }) => stream === EXEC_STREAM.STDOUT);
      expect(Buffer.concat(out.map(({ payload }) => payload))).toHaveLength(100000);
      expect(Math.max(...out.map(({ payload }) => payload.length))).toBeLessThanOrEqual(8192);
    });

    it('keeps two commands apart', async () => {
      const url = await serve();

      const [a, b] = await Promise.all([exec(url, 'sh', ['-c', 'echo a']), exec(url, 'sh', ['-c', 'echo b'])]);
      const [first, second] = (await Promise.all([a.json(), b.json()])) as { cmdId: string }[];

      expect(text(await exited(first?.cmdId), EXEC_STREAM.STDOUT)).toBe('a\n');
      expect(text(await exited(second?.cmdId), EXEC_STREAM.STDOUT)).toBe('b\n');
    });

    it('passes cwd and env', async () => {
      const url = await serve();

      await exec(url, 'sh', ['-c', 'pwd; echo $WHO'], { cwd: '/', env: { WHO: 'me' } });

      expect(text(await exited(), EXEC_STREAM.STDOUT)).toBe('/\nme\n');
    });

    it('gives a command no input', async () => {
      const url = await serve();

      await exec(url, 'cat', []);

      expect(JSON.parse(text(await exited(), EXEC_STREAM.EXIT))).toMatchObject({ code: 0 });
    });

    it.each([
      ['not JSON', 'nope'],
      ['not an Exec event', '{"kind":"Cron"}'],
    ])('refuses a body that is %s', async (_, body) => {
      const url = await serve();

      const response = await fetch(`${url}${EXEC_PATH}`, { method: 'POST', body });

      expect(response.status).toBe(400);
      expect(written).toEqual([]);
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
