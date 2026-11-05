import { Logger } from '@scaffoldly/rowdy';
import { CommandFinished, Sandbox, SandboxOptions } from '@scaffoldly/rowdy/sandbox';
import { AxiosError, AxiosHeaders, InternalAxiosRequestConfig } from 'axios';
import { InvokeWithResponseStreamResponseEvent, LambdaClient } from '@aws-sdk/client-lambda';
import { lastValueFrom, NEVER, Observable, of, Subject, throwError, toArray } from 'rxjs';
import { PassThrough } from 'stream';
import { ROWDY_LAYERS } from '../src/api/internal/layers';
import { LambdaFunction } from '../src/aws/lambda/index';
import { Exec } from '../src/api/types';
import { EXEC_STREAM, execFrame } from '../src/proxy/shell';
import { computeHash, SandboxImpl } from '../src/sandbox/internal/sandbox';

const FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:sandbox-box';

type Event = InvokeWithResponseStreamResponseEvent;

const payload = (Payload: Buffer): Event => ({ PayloadChunk: { Payload } });

async function* stream(...events: Event[]): AsyncGenerator<Event> {
  yield* events;
}

// Compiled, not called: ts-jest fails the suite if the types drift from these shapes.
const _shapes = async (sandbox: Sandbox): Promise<void> => {
  const finished: CommandFinished = await sandbox.runCommand('echo', ['hello world']);
  const _exitCode: number = finished.exitCode;
  const _output: string = await finished.stdout();
};

describe('sandbox', () => {
  const deployed = (): Observable<LambdaFunction> => of(LambdaFunction.prototype);
  let observe: jest.SpyInstance<Observable<LambdaFunction>>;

  beforeEach(() => {
    observe = jest.spyOn(LambdaFunction.prototype, 'observe').mockImplementation(deployed);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('create', () => {
    it('deploys once, then resolves to the sandbox', async () => {
      const deploy = new Subject<LambdaFunction>();
      observe.mockReturnValue(deploy);
      let resolved = false;

      const created = SandboxImpl.create().then((sandbox) => {
        resolved = true;
        return sandbox;
      });
      await Promise.resolve();
      deploy.next(LambdaFunction.prototype);
      await Promise.resolve();
      expect(resolved).toBe(false);

      deploy.complete();

      expect(await created).toBeInstanceOf(SandboxImpl);
      expect(observe).toHaveBeenCalledTimes(1);
    });

    it("adds rowdy's layer", async () => {
      const sandbox = await SandboxImpl.create();

      expect(sandbox['lambda'].imageService['_layersFrom']).toEqual([ROWDY_LAYERS]);
    });

    it.each([
      ['no options', undefined],
      ['an undefined image', { image: undefined }],
    ])('defaults to the sandbox image with %s', async (_, options) => {
      const image = jest.spyOn(LambdaFunction.prototype, 'withImage');

      await SandboxImpl.create(options);

      expect(image).toHaveBeenCalledWith('scaffoldly/sandbox');
    });

    it('deploys a sandbox, marked so it may exec', async () => {
      const sandbox = await SandboxImpl.create();

      expect(sandbox['lambda'].isSandbox()).toBe(true);
      expect(sandbox['lambda']['Environment'].value.ROWDY_SANDBOX).toBe('true');
    });

    it("drops the image's command", async () => {
      const sandbox = await SandboxImpl.create();

      expect(sandbox['lambda']['Command'].value).toEqual([]);
    });

    it('applies its timeout in seconds', async () => {
      const timeout = jest.spyOn(LambdaFunction.prototype, 'withTimeout');

      await SandboxImpl.create({ timeout: 60_000 });

      expect(timeout).toHaveBeenCalledWith(60);
    });

    it('defaults to the 15 minute timeout', async () => {
      const timeout = jest.spyOn(LambdaFunction.prototype, 'withTimeout');

      await SandboxImpl.create();

      expect(timeout).toHaveBeenCalledWith(900);
    });

    it.each([
      [undefined, /^sandbox-[bcdfghjklmnpqrstvwxz2456789]{1,10}$/],
      [{ image: 'python:3.14' }, /^sandbox-[bcdfghjklmnpqrstvwxz2456789]{1,10}$/],
      [{ name: '' }, /^sandbox-[bcdfghjklmnpqrstvwxz2456789]{1,10}$/],
      [{ image: 'ghcr.io/acme/app:v1', name: 'box' }, /^box-[bcdfghjklmnpqrstvwxz2456789]{1,10}$/],
    ])('names %j %s', async (options, expected) => {
      const name = jest.spyOn(LambdaFunction.prototype, 'withName');

      await SandboxImpl.create(options);

      expect(name).toHaveBeenCalledWith(expect.stringMatching(expected));
    });

    it.each([
      ['', '65bb57b6b5'],
      ['a', '7d6b446664'],
      ['foobar', '7658c79c64'],
      ['{"image":"e2bdev/base","timeout":900000,"memory":512,"env":[]}', '5d7cf9cbb'],
    ])("matches Kubernetes' ComputeHash for %j", (template, expected) => {
      expect(computeHash(template)).toBe(expected);
    });

    describe('suffix', () => {
      const named = async (options?: SandboxOptions): Promise<string> => {
        const name = jest.spyOn(LambdaFunction.prototype, 'withName');
        await SandboxImpl.create(options);
        const generated = name.mock.calls[name.mock.calls.length - 1]![0];
        name.mockRestore();
        return generated;
      };

      it('hashes the resolved config as its pod template', async () => {
        expect(await named()).toBe('sandbox-87bc69597');
      });

      it('is the same for the same options', async () => {
        expect(await named({ memory: 1024 })).toBe(await named({ memory: 1024 }));
      });

      it('resolves defaults first', async () => {
        expect(await named()).toBe(
          await named({ image: 'scaffoldly/sandbox', memory: 512, timeout: 900_000, env: {} })
        );
      });

      it.each<[string, SandboxOptions]>([
        ['image', { image: 'python:3.14' }],
        ['memory', { memory: 1024 }],
        ['timeout', { timeout: 60_000 }],
        ['env', { env: { FOO: 'bar' } }],
      ])('changes with %s', async (_, options) => {
        expect(await named(options)).not.toBe(await named());
      });

      it('ignores the order of env', async () => {
        expect(await named({ env: { A: '1', B: '2' } })).toBe(await named({ env: { B: '2', A: '1' } }));
      });

      it('ignores logLevel and signal, which do not reach the function', async () => {
        const options: SandboxOptions = { logLevel: 'warn', signal: new AbortController().signal };

        expect(await named(options)).toBe(await named());
      });

      it('leaves the suffix to the options, not the name', async () => {
        const [box, bag] = [await named({ name: 'box' }), await named({ name: 'bag' })];

        expect(box.replace('box-', '')).toBe(bag.replace('bag-', ''));
      });
    });

    it('keeps a sandbox off the function of an unnamed deploy', async () => {
      const sandbox = await SandboxImpl.create();
      const { value } = sandbox['lambda']['Image'];

      expect(LambdaFunction.roleName(value.normalized, sandbox['lambda']['Name'].value)).not.toBe(
        LambdaFunction.roleName(value.normalized)
      );
    });

    it('rejects an invalid image before deploying', async () => {
      await expect(SandboxImpl.create({ image: 'acme/' })).rejects.toThrow('Unable to normalize');

      expect(observe).not.toHaveBeenCalled();
    });

    it('applies its options to the function', async () => {
      const image = jest.spyOn(LambdaFunction.prototype, 'withImage');
      const name = jest.spyOn(LambdaFunction.prototype, 'withName');
      const memory = jest.spyOn(LambdaFunction.prototype, 'withMemory');
      const env = jest.spyOn(LambdaFunction.prototype, 'withEnvironment');

      await SandboxImpl.create({ image: 'busybox', name: 'box', memory: 512, env: { FOO: 'bar' } });

      expect(image).toHaveBeenCalledWith('busybox');
      expect(name).toHaveBeenCalledWith(expect.stringMatching(/^box-/));
      expect(memory).toHaveBeenCalledWith(512);
      expect(env).toHaveBeenCalledWith('FOO', 'bar');
    });

    it.each([
      ['a timeout under 1 second', { timeout: 999 }],
      ['a timeout over 15 minutes', { timeout: 900_001 }],
      ['a timeout of partial seconds', { timeout: 1500 }],
      ['a timeout that is not a number', { timeout: NaN }],
      ['memory under 128 MB', { memory: 127 }],
      ['memory over 10240 MB', { memory: 10241 }],
      ['memory of partial MB', { memory: 512.5 }],
    ])('rejects %s before deploying', async (_, options) => {
      await expect(SandboxImpl.create(options)).rejects.toThrow(RangeError);

      expect(observe).not.toHaveBeenCalled();
    });

    it.each([[{ timeout: 1000, memory: 128 }], [{ timeout: 900_000, memory: 10240 }]])(
      'accepts the limits %j',
      async (options) => {
        await expect(SandboxImpl.create(options)).resolves.toBeInstanceOf(SandboxImpl);
      }
    );

    it('keeps HOME and the XDG directories under /tmp, apart', async () => {
      const sandbox = await SandboxImpl.create();

      expect(sandbox['lambda']['Environment'].value).toMatchObject({
        HOME: '/tmp',
        XDG_CACHE_HOME: '/tmp/.cache',
        XDG_CONFIG_HOME: '/tmp/.config',
        XDG_DATA_HOME: '/tmp/.local/share',
        XDG_STATE_HOME: '/tmp/.local/state',
      });
    });

    it('lets env override the defaults', async () => {
      const sandbox = await SandboxImpl.create({ env: { HOME: '/mnt', FOO: 'bar' } });

      expect(sandbox['lambda']['Environment'].value).toMatchObject({
        HOME: '/mnt',
        FOO: 'bar',
        XDG_DATA_HOME: '/tmp/.local/share',
      });
    });

    it('reduces an http failure to its method, url and status', async () => {
      const config: InternalAxiosRequestConfig = {
        headers: new AxiosHeaders({ Authorization: 'Bearer secret' }),
        method: 'get',
        url: 'https://mirror.gcr.io/v2/e2bdev/base/blobs/sha256:abc',
      };
      const response = { status: 404, statusText: '', data: '', headers: {}, config };
      observe.mockReturnValue(throwError(() => new AxiosError('failed', 'ERR_BAD_REQUEST', config, null, response)));

      const error = await SandboxImpl.create().catch((e) => e);

      expect(error).not.toBeInstanceOf(AxiosError);
      expect(error.message).toBe('GET https://mirror.gcr.io/v2/e2bdev/base/blobs/sha256:abc: 404');
    });

    it('aborts its environment when the deploy fails', async () => {
      const error = new Error('Region is missing');
      const abort = jest.spyOn(AbortController.prototype, 'abort');
      observe.mockReturnValue(throwError(() => error));

      await expect(SandboxImpl.create()).rejects.toBe(error);

      expect(abort).toHaveBeenCalledWith(error);
    });

    describe('log level', () => {
      const { ROWDY_LOG_LEVEL } = process.env;

      beforeEach(() => {
        delete process.env.ROWDY_LOG_LEVEL;
        new Logger().withLevel(undefined);
      });

      afterEach(() => {
        delete process.env.ROWDY_DEBUG;
        if (ROWDY_LOG_LEVEL === undefined) {
          delete process.env.ROWDY_LOG_LEVEL;
        } else {
          process.env.ROWDY_LOG_LEVEL = ROWDY_LOG_LEVEL;
        }
        new Logger().withLevel(undefined);
      });

      it('is warn by default', async () => {
        await SandboxImpl.create();

        expect(new Logger().level).toBe('warn');
      });

      it('takes logLevel over ROWDY_LOG_LEVEL', async () => {
        process.env.ROWDY_LOG_LEVEL = 'trace';

        await SandboxImpl.create({ logLevel: 'error' });

        expect(new Logger().level).toBe('error');
      });

      it('follows ROWDY_LOG_LEVEL', async () => {
        process.env.ROWDY_LOG_LEVEL = 'info';

        await SandboxImpl.create();

        expect(new Logger().level).toBe('info');
      });

      it('follows ROWDY_DEBUG', async () => {
        process.env.ROWDY_DEBUG = 'true';

        await SandboxImpl.create();

        expect(new Logger().level).toBe('debug');
      });
    });

    it('rejects when the deploy fails', async () => {
      observe.mockReturnValue(throwError(() => new Error('AccessDenied')));

      await expect(SandboxImpl.create()).rejects.toThrow('AccessDenied');
    });

    it('rejects with the reason and stops the deploy when aborted', async () => {
      let stopped = false;
      observe.mockReturnValue(
        new Observable<LambdaFunction>(() => () => {
          stopped = true;
        })
      );
      const controller = new AbortController();

      const created = SandboxImpl.create({ signal: controller.signal });
      await Promise.resolve();
      controller.abort('stop');

      await expect(created).rejects.toBe('stop');
      expect(stopped).toBe(true);
    });

    it('does not deploy when already aborted', async () => {
      observe.mockReturnValue(NEVER);

      await expect(SandboxImpl.create({ signal: AbortSignal.abort('stop') })).rejects.toBe('stop');
      expect(observe).not.toHaveBeenCalled();
    });
  });

  it('runs the documented example', async () => {
    const send = jest.spyOn(LambdaClient.prototype, 'send');
    send.mockImplementation(() =>
      Promise.resolve({
        $metadata: { requestId: 'req' },
        EventStream: stream(payload(execFrame(EXEC_STREAM.EXIT, Buffer.from('{"code":0}')))),
      })
    );
    observe.mockImplementation(function (this: LambdaFunction) {
      this.State.FunctionArn = FUNCTION_ARN;
      return of(this);
    });

    const sandbox = await Sandbox.create({ timeout: 15 * 60 * 1000 });
    const finished = await sandbox.runCommand({
      cmd: 'echo',
      args: ['hello world'],
      stdout: process.stdout,
      stderr: process.stderr,
    });

    expect(finished.exitCode).toBe(0);
  });

  describe('sandboxId', () => {
    it('is the function arn', async () => {
      const sandbox = await SandboxImpl.create();
      sandbox['lambda'].State.FunctionArn = FUNCTION_ARN;

      expect(sandbox.sandboxId).toBe(FUNCTION_ARN);
    });

    it('throws before a function exists', async () => {
      const sandbox = await SandboxImpl.create();

      expect(() => sandbox.sandboxId).toThrow('Sandbox has no function');
    });
  });

  describe('runCommand', () => {
    const start = async (...events: Event[]): Promise<{ sandbox: SandboxImpl; send: jest.SpyInstance }> => {
      const send = jest.spyOn(LambdaClient.prototype, 'send');
      send.mockImplementation(() =>
        Promise.resolve({ $metadata: { requestId: 'req' }, EventStream: stream(...events) })
      );
      const sandbox = await SandboxImpl.create();
      sandbox['lambda'].State.FunctionArn = FUNCTION_ARN;
      return { sandbox, send };
    };

    const exited = payload(execFrame(EXEC_STREAM.EXIT, Buffer.from('{"code":0}')));

    it('invokes $LATEST with an Exec event', async () => {
      const { sandbox, send } = await start(exited);

      await sandbox.runCommand({ cmd: 'ls', args: ['-l'], cwd: '/tmp', env: { FOO: 'bar' } });

      const { input } = send.mock.calls[0]![0] as {
        input: { FunctionName: string; Qualifier: string; Payload: Buffer };
      };
      expect(input.FunctionName).toBe(FUNCTION_ARN);
      expect(input.Qualifier).toBe('$LATEST');
      expect(JSON.parse(input.Payload.toString())).toEqual({
        apiVersion: 'rowdy.run/v1alpha1',
        kind: 'Exec',
        spec: { cmd: 'ls', args: ['-l'], cwd: '/tmp', env: { FOO: 'bar' } },
      });
    });

    it('takes a cmd and args', async () => {
      const { sandbox, send } = await start(exited);

      await sandbox.runCommand('echo', ['hi']);

      const { input } = send.mock.calls[0]![0] as { input: { Payload: Buffer } };
      expect(JSON.parse(input.Payload.toString()).spec).toEqual({ cmd: 'echo', args: ['hi'] });
    });

    it('does not retry a command', async () => {
      const sandbox = await SandboxImpl.create();

      await expect(sandbox['lambda']['invoker'].config.maxAttempts()).resolves.toBe(1);
    });

    it('collects stdout, stderr and the exit code', async () => {
      const { sandbox } = await start(
        payload(execFrame(EXEC_STREAM.STDOUT, Buffer.from('out'))),
        payload(execFrame(EXEC_STREAM.STDERR, Buffer.from('err'))),
        payload(execFrame(EXEC_STREAM.EXIT, Buffer.from('{"code":3}')))
      );

      const finished = await sandbox.runCommand('sh');

      expect(finished.cmdId).toBe('req');
      expect(finished.exitCode).toBe(3);
      expect(await finished.stdout()).toBe('out');
      expect(await finished.stderr()).toBe('err');
      expect(await finished.wait()).toBe(finished);
    });

    it('resolves a non-zero exit', async () => {
      const { sandbox } = await start(payload(execFrame(EXEC_STREAM.EXIT, Buffer.from('{"code":127}'))));

      await expect(sandbox.runCommand('nope')).resolves.toMatchObject({ exitCode: 127 });
    });

    it('writes to the given streams as frames arrive', async () => {
      const { sandbox } = await start(
        payload(execFrame(EXEC_STREAM.STDOUT, Buffer.from('out'))),
        payload(execFrame(EXEC_STREAM.STDERR, Buffer.from('err'))),
        exited
      );
      const stdout = new PassThrough();
      const stderr = new PassThrough();

      await sandbox.runCommand({ cmd: 'sh', stdout, stderr });

      expect(stdout.read().toString()).toBe('out');
      expect(stderr.read().toString()).toBe('err');
    });

    it('reassembles a frame split across chunks, and several frames in one', async () => {
      const bytes = Buffer.concat([
        execFrame(EXEC_STREAM.STDOUT, Buffer.from('hello ')),
        execFrame(EXEC_STREAM.STDOUT, Buffer.from('world')),
        execFrame(EXEC_STREAM.EXIT, Buffer.from('{"code":0}')),
      ]);
      const { sandbox } = await start(
        payload(bytes.subarray(0, 3)),
        payload(bytes.subarray(3, 20)),
        payload(bytes.subarray(20))
      );

      const finished = await sandbox.runCommand('sh');

      expect(await finished.stdout()).toBe('hello world');
    });

    it('keeps a multi-byte character split across frames', async () => {
      const euro = Buffer.from('€');
      const { sandbox } = await start(
        payload(execFrame(EXEC_STREAM.STDOUT, euro.subarray(0, 1))),
        payload(execFrame(EXEC_STREAM.STDOUT, euro.subarray(1))),
        exited
      );

      expect(await (await sandbox.runCommand('sh')).stdout()).toBe('€');
    });

    describe('exec', () => {
      const run = (lambda: LambdaFunction) =>
        lambda.exec({ apiVersion: 'rowdy.run/v1alpha1', kind: 'Exec', spec: { cmd: 'sh' }, status: undefined });

      it('emits one handle, running until the exit arrives', async () => {
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => (release = resolve));
        const { sandbox, send } = await start();
        send.mockImplementation(() =>
          Promise.resolve({
            $metadata: { requestId: 'req' },
            EventStream: (async function* (): AsyncGenerator<Event> {
              yield payload(execFrame(EXEC_STREAM.STDOUT, Buffer.from('out')));
              await held;
              yield exited;
            })(),
          })
        );

        const handles: Exec[] = [];
        const subscription = run(sandbox['lambda']).subscribe((handle) => handles.push(handle));
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(handles).toHaveLength(1);
        expect(handles[0]!.cmdId).toBe('req');
        expect(handles[0]!.exitCode).toBeUndefined();
        expect(await handles[0]!.stdout()).toBe('out');

        release();
        const finished = await handles[0]!.wait();

        expect(finished.exitCode).toBe(0);
        expect(handles[0]!.exitCode).toBe(0);
        subscription.unsubscribe();
      });

      it('replays frames to a late subscriber', async () => {
        const { sandbox } = await start(payload(execFrame(EXEC_STREAM.STDOUT, Buffer.from('out'))), exited);

        const exec = await lastValueFrom(run(sandbox['lambda']));
        const frames = await lastValueFrom(exec.frames.pipe(toArray()));

        expect(frames.map(({ stream }) => stream)).toEqual([EXEC_STREAM.STDOUT, EXEC_STREAM.EXIT]);
      });

      it('fails the handle when abandoned', async () => {
        const { sandbox, send } = await start();
        send.mockImplementation(() =>
          Promise.resolve({
            $metadata: {},
            EventStream: (async function* (): AsyncGenerator<Event> {
              yield await new Promise<never>(() => undefined);
            })(),
          })
        );
        const handles: Exec[] = [];

        const subscription = run(sandbox['lambda']).subscribe((handle) => handles.push(handle));
        await new Promise((resolve) => setTimeout(resolve, 10));
        const waiting = handles[0]!.wait();
        subscription.unsubscribe();

        await expect(waiting).rejects.toThrow('Exec abandoned');
      });
    });

    it('rejects a failed invocation', async () => {
      const { sandbox } = await start({
        InvokeComplete: { ErrorCode: 'Runtime.Error', ErrorDetails: 'Request deadline reached' },
      });

      await expect(sandbox.runCommand('sh')).rejects.toThrow('Runtime.Error: Request deadline reached');
    });

    it('reports the end of the function log on a failed invocation', async () => {
      const LogResult = Buffer.from('Runtime.ExitError').toString('base64');
      const { sandbox } = await start({ InvokeComplete: { ErrorCode: 'Unhandled', LogResult } });

      await expect(sandbox.runCommand('sh')).rejects.toThrow('Unhandled: Runtime.ExitError');
    });

    it('asks for the function log', async () => {
      const { sandbox, send } = await start(exited);

      await sandbox.runCommand('sh');

      const { input } = send.mock.calls[0]![0] as { input: { LogType: string } };
      expect(input.LogType).toBe('Tail');
    });

    it('rejects a stream that ends without an exit', async () => {
      const { sandbox } = await start(payload(execFrame(EXEC_STREAM.STDOUT, Buffer.from('out'))), {
        InvokeComplete: {},
      });

      await expect(sandbox.runCommand('sh')).rejects.toThrow('Command ended without an exit');
    });

    it('rejects before a function exists', async () => {
      const sandbox = await SandboxImpl.create();

      await expect(sandbox.runCommand('sh')).rejects.toThrow('Exec needs a deployed sandbox');
    });

    it('stops waiting when its signal aborts', async () => {
      const { sandbox, send } = await start();
      const pending = new Promise<never>(() => undefined);
      send.mockImplementation(() =>
        Promise.resolve({
          $metadata: {},
          EventStream: (async function* (): AsyncGenerator<Event> {
            yield await pending;
          })(),
        })
      );
      const controller = new AbortController();

      const running = sandbox.runCommand({ cmd: 'sh', signal: controller.signal });
      await Promise.resolve();
      controller.abort('stop');

      await expect(running).rejects.toBe('stop');
      const { abortSignal } = send.mock.calls[0]![1] as { abortSignal: AbortSignal };
      expect(abortSignal.aborted).toBe(true);
    });

    it('does not invoke when its signal has already aborted', async () => {
      const { sandbox, send } = await start(exited);

      await expect(sandbox.runCommand({ cmd: 'sh', signal: AbortSignal.abort('stop') })).rejects.toBe('stop');

      expect(send).not.toHaveBeenCalled();
    });
  });

  it('exposes only create and get', () => {
    expect(Object.keys(Sandbox).sort()).toEqual(['create', 'get']);
  });

  it('feeds its signal to its environment', async () => {
    const controller = new AbortController();
    const sandbox = await SandboxImpl.create({ signal: controller.signal });

    controller.abort('stop');

    expect(sandbox['environment'].signal.reason).toBe('stop');
  });

  describe('get', () => {
    let withArn: jest.SpyInstance;
    const hydrate = (Variables: Record<string, string>) =>
      function (this: LambdaFunction): Observable<LambdaFunction> {
        this.State.FunctionArn = FUNCTION_ARN;
        this['_status'] = { Configuration: { Environment: { Variables } } };
        return of(this);
      };

    beforeEach(() => {
      withArn = jest.spyOn(LambdaFunction.prototype, 'withArn').mockImplementation(hydrate({ ROWDY_SANDBOX: 'true' }));
    });

    it('connects to the sandbox without deploying', async () => {
      const sandbox = await Sandbox.get({ sandboxId: FUNCTION_ARN });

      expect(withArn).toHaveBeenCalledWith(FUNCTION_ARN);
      expect(observe).not.toHaveBeenCalled();
      expect(sandbox.sandboxId).toBe(FUNCTION_ARN);
    });

    it('rejects a function that is not a sandbox', async () => {
      withArn.mockImplementation(hydrate({}));

      await expect(Sandbox.get({ sandboxId: FUNCTION_ARN })).rejects.toThrow(`Not a sandbox: ${FUNCTION_ARN}`);
    });

    it('rejects a lookup that fails', async () => {
      withArn.mockReturnValue(throwError(() => new Error('ResourceNotFoundException')));

      await expect(Sandbox.get({ sandboxId: FUNCTION_ARN })).rejects.toThrow('ResourceNotFoundException');
    });

    it('rejects with the reason when aborted', async () => {
      await expect(Sandbox.get({ sandboxId: FUNCTION_ARN, signal: AbortSignal.abort('stop') })).rejects.toBe('stop');

      expect(withArn).not.toHaveBeenCalled();
    });

    it('runs commands', async () => {
      jest.spyOn(LambdaClient.prototype, 'send').mockImplementation(() =>
        Promise.resolve({
          $metadata: {},
          EventStream: stream(payload(execFrame(EXEC_STREAM.EXIT, Buffer.from('{"code":0}')))),
        })
      );

      const sandbox = await Sandbox.get({ sandboxId: FUNCTION_ARN });

      await expect(sandbox.runCommand('ls')).resolves.toMatchObject({ exitCode: 0 });
    });
  });

  describe('an instance', () => {
    const sandbox: Sandbox = Object.create(SandboxImpl.prototype);

    it('has no extendTimeout', () => {
      expect('extendTimeout' in sandbox).toBe(false);
    });
  });
});
