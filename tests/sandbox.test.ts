import { Logger } from '@scaffoldly/rowdy';
import {
  CommandFinished,
  Sandbox,
  SandboxFactory,
  SandboxOptions,
  SandboxSummary,
  SandboxToolsOptions,
  Tool,
} from '@scaffoldly/rowdy/sandbox';
import * as mcp from '@scaffoldly/rowdy/mcp';
import { AxiosError, AxiosHeaders, InternalAxiosRequestConfig } from 'axios';
import { InvokeWithResponseStreamResponseEvent, LambdaClient } from '@aws-sdk/client-lambda';
import {
  EMPTY,
  from,
  lastValueFrom,
  map,
  NEVER,
  Observable,
  of,
  Subject,
  switchMap,
  tap,
  throwError,
  toArray,
} from 'rxjs';
import type { ServerContext } from '@modelcontextprotocol/server';
import { PassThrough } from 'stream';
import { ROWDY_LAYERS } from '../src/api/internal/layers';
import { CreateRepositoryCommand } from '@aws-sdk/client-ecr';
import { LambdaCompute } from '../src/aws/lambda/compute';
import { AwsRegistry } from '../src/aws/registry';
import type { Event as SandboxEvent } from '../src/events';
import { LambdaFunction } from '../src/aws/lambda/index';
import { MicrovmCompute } from '../src/aws/microvm/compute';
import { LambdaImageService } from '../src/aws/lambda/image';
import { SandboxEnvironment } from '../src/sandbox/internal/environment';
import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { Exec, ExecFinished, ExecFrame } from '../src/api/types';
import { execOf } from '../src/aws/exec';
import { SandboxError } from '../src/sandbox/internal/compute';
import { EXEC_STREAM, execFrame } from '../src/proxy/shell';
import { computeHash, SandboxImpl } from '../src/sandbox/internal/sandbox';
import { createSandbox, OWN_TOOLS } from '../src/sandbox/internal/mcp/create-sandbox';
import { getSandbox } from '../src/sandbox/internal/mcp/get-sandbox';

const FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:sandbox-box';

const lambdaOf = (sandbox: SandboxImpl): LambdaFunction => (sandbox['compute'] as LambdaCompute)['lambda']!;

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

const _options: SandboxOptions[] = [
  { memory: 1024 },
  { runtime: 'aws.lambda', memory: 600 },
  { runtime: 'aws.microvm', memory: 1024 },
  // @ts-expect-error A microVM's memory is one of AWS's sizes, and it's the default.
  { memory: 600 },
  // @ts-expect-error A microVM's memory is one of AWS's sizes.
  { runtime: 'aws.microvm', memory: 600 },
];

// The default options as they were hashed before compute joined them.
const UNHASHED =
  '{"image":"scaffoldly/sandbox","timeout":900000,"memory":512,"env":[["HOME","/tmp"],["XDG_CACHE_HOME","/tmp/.cache"],["XDG_CONFIG_HOME","/tmp/.config"],["XDG_DATA_HOME","/tmp/.local/share"],["XDG_STATE_HOME","/tmp/.local/state"]]}';

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

      const created = SandboxImpl.create({ runtime: 'aws.lambda' }).then((sandbox) => {
        resolved = true;
        return sandbox;
      });
      // The deployer loads on demand, so its deploy starts a few ticks later.
      while (!observe.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 0));
      deploy.next(LambdaFunction.prototype);
      await Promise.resolve();
      expect(resolved).toBe(false);

      deploy.complete();

      expect(await created).toBeInstanceOf(SandboxImpl);
      expect(observe).toHaveBeenCalledTimes(1);
    });

    it("adds rowdy's layer", async () => {
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });

      expect(lambdaOf(sandbox).imageService['_layersFrom']).toEqual([ROWDY_LAYERS]);
    });

    it("adds the options' layers after rowdy's", async () => {
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda', layersFrom: ['tunneld/tunneld:latest'] });

      expect(lambdaOf(sandbox).imageService['_layersFrom']).toEqual([ROWDY_LAYERS, 'tunneld/tunneld:latest']);
    });

    it('gives different layers a different name, and no layers the name it had before', async () => {
      const name = jest.spyOn(LambdaFunction.prototype, 'withName');

      await SandboxImpl.create({ runtime: 'aws.lambda' });
      await SandboxImpl.create({ runtime: 'aws.lambda', layersFrom: [] });
      await SandboxImpl.create({ runtime: 'aws.lambda', layersFrom: ['tunneld/tunneld:latest'] });

      const [none, empty, layered] = name.mock.calls.map(([each]) => each);
      expect(empty).toBe(none);
      expect(layered).not.toBe(none);
    });

    it.each([
      ['no options', undefined],
      ['an undefined image', { image: undefined }],
    ])('defaults to the sandbox image with %s', async (_, options) => {
      const image = jest.spyOn(LambdaFunction.prototype, 'withImage');

      await SandboxImpl.create({ runtime: 'aws.lambda', ...options } as SandboxOptions);

      expect(image).toHaveBeenCalledWith('scaffoldly/sandbox');
    });

    it('runs a microvm on its own compute', async () => {
      const create = jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });

      const sandbox = await SandboxImpl.create();

      expect(sandbox['compute']).toBeInstanceOf(MicrovmCompute);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ image: 'scaffoldly/sandbox', memory: 512, env: {} })
      );
      expect(observe).not.toHaveBeenCalled();
    });

    it('holds a microvm to its own limits, before anything reaches AWS', async () => {
      const create = jest.spyOn(MicrovmCompute.prototype, 'create');

      await expect(SandboxImpl.create({ runtime: 'aws.microvm', memory: 600 as never })).rejects.toThrow(
        'memory must be one of'
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('gives the same options a different name on each compute', async () => {
      const name = jest.fn();
      jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute, spec) {
        name(spec.name);
        return of(this);
      });
      const lambda = jest.spyOn(LambdaFunction.prototype, 'withName');

      await SandboxImpl.create({ runtime: 'aws.lambda' });
      await SandboxImpl.create({ runtime: 'aws.microvm' });

      expect(name.mock.calls[0]?.[0]).not.toEqual(lambda.mock.calls[0]?.[0]);
    });

    it('hashes the compute', async () => {
      const name = jest.spyOn(LambdaFunction.prototype, 'withName');

      await SandboxImpl.create({ runtime: 'aws.lambda' });
      await SandboxImpl.create({ runtime: 'aws.lambda' });

      expect(name.mock.calls[0]).toEqual(name.mock.calls[1]);
      expect(name.mock.calls[0]).not.toEqual([`sandbox-${computeHash(UNHASHED)}`]);
    });

    it('gives different meta a different name, and no meta the name it had before', async () => {
      const name = jest.spyOn(LambdaFunction.prototype, 'withName');
      const tag = jest.spyOn(LambdaFunction.prototype, 'withTag');

      await SandboxImpl.create({ runtime: 'aws.lambda' });
      await SandboxImpl.create({ runtime: 'aws.lambda', meta: {} });
      await SandboxImpl.create({ runtime: 'aws.lambda', meta: { sub: 'github:1' } });
      await SandboxImpl.create({ runtime: 'aws.lambda', meta: { sub: 'github:2' } });

      const [none, empty, one, two] = name.mock.calls.map(([each]) => each);
      expect(empty).toBe(none);
      expect(new Set([none, one, two]).size).toBe(3);
      expect(tag).toHaveBeenCalledWith('run.rowdy.meta.sub', 'github:1');
    });

    it('refuses meta AWS would not tag, before anything reaches AWS', async () => {
      const name = jest.spyOn(LambdaFunction.prototype, 'withName');

      await expect(SandboxImpl.create({ runtime: 'aws.lambda', meta: { 'a/b': 'x' } })).rejects.toThrow(
        'meta must be what AWS takes in a tag'
      );
      expect(name).not.toHaveBeenCalled();
    });

    it('deploys a sandbox, marked so it may exec', async () => {
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });

      expect(lambdaOf(sandbox).isSandbox()).toBe(true);
      expect(lambdaOf(sandbox)['Environment'].value.ROWDY_SANDBOX).toBe('true');
    });

    it("drops the image's command", async () => {
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });

      expect(lambdaOf(sandbox)['Command'].value).toEqual([]);
    });

    it('applies its timeout in seconds', async () => {
      const timeout = jest.spyOn(LambdaFunction.prototype, 'withTimeout');

      await SandboxImpl.create({ runtime: 'aws.lambda', timeout: 60_000 });

      expect(timeout).toHaveBeenCalledWith(60);
    });

    it('defaults to the 15 minute timeout', async () => {
      const timeout = jest.spyOn(LambdaFunction.prototype, 'withTimeout');

      await SandboxImpl.create({ runtime: 'aws.lambda' });

      expect(timeout).toHaveBeenCalledWith(900);
    });

    it.each([
      [undefined, /^sandbox-[bcdfghjklmnpqrstvwxz2456789]{1,10}$/],
      [{ image: 'python:3.14' }, /^sandbox-[bcdfghjklmnpqrstvwxz2456789]{1,10}$/],
      [{ name: '' }, /^sandbox-[bcdfghjklmnpqrstvwxz2456789]{1,10}$/],
      [{ image: 'ghcr.io/acme/app:v1', name: 'box' }, /^box-[bcdfghjklmnpqrstvwxz2456789]{1,10}$/],
    ])('names %j %s', async (options, expected) => {
      const name = jest.spyOn(LambdaFunction.prototype, 'withName');

      await SandboxImpl.create({ runtime: 'aws.lambda', ...options } as SandboxOptions);

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
        await SandboxImpl.create({ runtime: 'aws.lambda', ...options } as SandboxOptions);
        const generated = name.mock.calls[name.mock.calls.length - 1]![0];
        name.mockRestore();
        return generated;
      };

      it('hashes the resolved config as its pod template', async () => {
        expect(await named()).toBe('sandbox-bc889d8b9');
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
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });
      const { value } = lambdaOf(sandbox)['Image'];

      expect(LambdaFunction.roleName(value.normalized, lambdaOf(sandbox)['Name'].value)).not.toBe(
        LambdaFunction.roleName(value.normalized)
      );
    });

    it('rejects an invalid image before deploying', async () => {
      await expect(SandboxImpl.create({ runtime: 'aws.lambda', image: 'acme/' })).rejects.toThrow(
        'Unable to normalize'
      );

      expect(observe).not.toHaveBeenCalled();
    });

    it('applies its options to the function', async () => {
      const image = jest.spyOn(LambdaFunction.prototype, 'withImage');
      const name = jest.spyOn(LambdaFunction.prototype, 'withName');
      const memory = jest.spyOn(LambdaFunction.prototype, 'withMemory');
      const env = jest.spyOn(LambdaFunction.prototype, 'withEnvironment');

      await SandboxImpl.create({
        runtime: 'aws.lambda',
        image: 'busybox',
        name: 'box',
        memory: 512,
        env: { FOO: 'bar' },
      });

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
      await expect(SandboxImpl.create({ runtime: 'aws.lambda', ...options } as SandboxOptions)).rejects.toThrow(
        RangeError
      );

      expect(observe).not.toHaveBeenCalled();
    });

    it.each([[{ timeout: 1000, memory: 128 }], [{ timeout: 900_000, memory: 10240 }]])(
      'accepts the limits %j',
      async (options) => {
        await expect(
          SandboxImpl.create({ runtime: 'aws.lambda', ...options } as SandboxOptions)
        ).resolves.toBeInstanceOf(SandboxImpl);
      }
    );

    it('keeps HOME and the XDG directories under /tmp, apart', async () => {
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });

      expect(lambdaOf(sandbox)['Environment'].value).toMatchObject({
        HOME: '/tmp',
        XDG_CACHE_HOME: '/tmp/.cache',
        XDG_CONFIG_HOME: '/tmp/.config',
        XDG_DATA_HOME: '/tmp/.local/share',
        XDG_STATE_HOME: '/tmp/.local/state',
      });
    });

    it('lets env override the defaults', async () => {
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda', env: { HOME: '/mnt', FOO: 'bar' } });

      expect(lambdaOf(sandbox)['Environment'].value).toMatchObject({
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

      const error = await SandboxImpl.create({ runtime: 'aws.lambda' }).catch((e) => e);

      expect(error).not.toBeInstanceOf(AxiosError);
      expect(error.message).toBe('GET https://mirror.gcr.io/v2/e2bdev/base/blobs/sha256:abc: 404');
    });

    it('keeps what failed when an http request gets no response', async () => {
      const config: InternalAxiosRequestConfig = { headers: new AxiosHeaders(), method: 'get', url: 'https://x/v2/' };
      observe.mockReturnValue(throwError(() => new AxiosError('Too many subrequests.', 'ERR_NETWORK', config)));

      const error = await SandboxImpl.create({ runtime: 'aws.lambda' }).catch((e) => e);

      expect(error.message).toBe('GET https://x/v2/: Too many subrequests.');
    });

    it('aborts its environment when the deploy fails', async () => {
      const error = new Error('Region is missing');
      const abort = jest.spyOn(AbortController.prototype, 'abort');
      observe.mockReturnValue(throwError(() => error));

      await expect(SandboxImpl.create({ runtime: 'aws.lambda' })).rejects.toBe(error);

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
        await SandboxImpl.create({ runtime: 'aws.lambda' });

        expect(new Logger().level).toBe('warn');
      });

      it('takes logLevel on get too, for a process that never creates', async () => {
        jest.spyOn(LambdaCompute.prototype, 'attach').mockImplementation(function (this: LambdaCompute) {
          return of(this);
        });

        await SandboxImpl.get({ sandboxId: FUNCTION_ARN, logLevel: 'error' });

        expect(new Logger().level).toBe('error');
      });

      it('takes logLevel over ROWDY_LOG_LEVEL', async () => {
        process.env.ROWDY_LOG_LEVEL = 'trace';

        await SandboxImpl.create({ runtime: 'aws.lambda', logLevel: 'error' });

        expect(new Logger().level).toBe('error');
      });

      it('follows ROWDY_LOG_LEVEL', async () => {
        process.env.ROWDY_LOG_LEVEL = 'info';

        await SandboxImpl.create({ runtime: 'aws.lambda' });

        expect(new Logger().level).toBe('info');
      });

      it('follows ROWDY_DEBUG', async () => {
        process.env.ROWDY_DEBUG = 'true';

        await SandboxImpl.create({ runtime: 'aws.lambda' });

        expect(new Logger().level).toBe('debug');
      });

      it('leaves stdout to the host: every level goes to stderr', async () => {
        const info = jest.spyOn(console, 'info').mockImplementation(() => {});
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await SandboxImpl.create({ runtime: 'aws.lambda', logLevel: 'info' });
        new Logger().info('hello');
        new Logger().withSink(undefined);

        expect(info).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);
      });
    });

    it('rejects when the deploy fails', async () => {
      observe.mockReturnValue(throwError(() => new Error('AccessDenied')));

      await expect(SandboxImpl.create({ runtime: 'aws.lambda' })).rejects.toThrow('AccessDenied');
    });

    it('rejects with the reason and stops the deploy when aborted', async () => {
      let stopped = false;
      observe.mockReturnValue(
        new Observable<LambdaFunction>(() => () => {
          stopped = true;
        })
      );
      const controller = new AbortController();

      const created = SandboxImpl.create({ runtime: 'aws.lambda', signal: controller.signal });
      // The deployer loads on demand, so its deploy starts a few ticks later.
      while (!observe.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort('stop');

      await expect(created).rejects.toBe('stop');
      expect(stopped).toBe(true);
    });

    it('does not deploy when already aborted', async () => {
      observe.mockReturnValue(NEVER);

      await expect(SandboxImpl.create({ runtime: 'aws.lambda', signal: AbortSignal.abort('stop') })).rejects.toBe(
        'stop'
      );
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

    const sandbox = await Sandbox.create({ runtime: 'aws.lambda', timeout: 15 * 60 * 1000 });
    const finished = await sandbox.runCommand({
      cmd: 'echo',
      args: ['hello world'],
      stdout: process.stdout,
      stderr: process.stderr,
    });

    expect(finished.exitCode).toBe(0);
  });

  describe("the sandbox's signal", () => {
    const microvm = (signal: AbortSignal): Promise<Sandbox> => {
      jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });
      jest.spyOn(MicrovmCompute.prototype, 'exec').mockReturnValue(NEVER);
      return Sandbox.create({ runtime: 'aws.microvm', signal });
    };

    it('aborts a command on a microvm', async () => {
      const controller = new AbortController();
      const sandbox = await microvm(controller.signal);
      const command = sandbox.runCommand('sleep', ['60']);

      controller.abort('bye');

      await expect(command).rejects.toBe('bye');
    });

    it('aborts a command with its own signal as well', async () => {
      const controller = new AbortController();
      const sandbox = await microvm(controller.signal);
      const command = sandbox.runCommand({ cmd: 'sleep', signal: new AbortController().signal });

      controller.abort('bye');

      await expect(command).rejects.toBe('bye');
    });

    it("leaves the sandbox alone when only a command's signal aborts", async () => {
      const controller = new AbortController();
      const sandbox = (await microvm(new AbortController().signal)) as SandboxImpl;
      const command = sandbox.runCommand({ cmd: 'sleep', signal: controller.signal });

      controller.abort('bye');

      await expect(command).rejects.toBe('bye');
      expect(sandbox['environment'].signal.aborted).toBe(false);
    });

    it('rejects a command on a sandbox already aborted', async () => {
      const controller = new AbortController();
      const sandbox = await microvm(controller.signal);
      controller.abort('bye');

      await expect(sandbox.runCommand('sleep', ['60'])).rejects.toBe('bye');
    });

    describe('stopping', () => {
      let stop: jest.SpyInstance;

      beforeEach(() => {
        stop = jest.spyOn(MicrovmCompute.prototype, 'stop').mockImplementation(function (this: MicrovmCompute) {
          return of(this);
        });
      });

      it('stops a microvm sandbox', async () => {
        const controller = new AbortController();
        await microvm(controller.signal);

        controller.abort('bye');

        expect(stop).toHaveBeenCalledTimes(1);
      });

      it('stops one reached by get', async () => {
        jest.spyOn(MicrovmCompute.prototype, 'attach').mockImplementation(function (this: MicrovmCompute) {
          return of(this);
        });
        const controller = new AbortController();
        await Sandbox.get({
          sandboxId: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox-box',
          signal: controller.signal,
        });

        controller.abort('bye');

        expect(stop).toHaveBeenCalledTimes(1);
      });

      it('stops once, with one signal on the sandbox and its command', async () => {
        const controller = new AbortController();
        const sandbox = await microvm(controller.signal);
        const command = sandbox.runCommand({ cmd: 'sleep', signal: controller.signal });

        controller.abort('bye');

        await expect(command).rejects.toBe('bye');
        expect(stop).toHaveBeenCalledTimes(1);
      });

      it("doesn't stop for a command's own signal", async () => {
        const controller = new AbortController();
        const sandbox = await microvm(new AbortController().signal);
        const command = sandbox.runCommand({ cmd: 'sleep', signal: controller.signal });

        controller.abort('bye');

        await expect(command).rejects.toBe('bye');
        expect(stop).not.toHaveBeenCalled();
      });

      it('has nothing to stop when aborted during create', async () => {
        const deploy = new Subject<never>();
        jest.spyOn(MicrovmCompute.prototype, 'create').mockReturnValue(deploy);
        const controller = new AbortController();
        const created = Sandbox.create({ runtime: 'aws.microvm', signal: controller.signal });
        await Promise.resolve();

        controller.abort('bye');

        await expect(created).rejects.toBe('bye');
        expect(stop).not.toHaveBeenCalled();
      });

      it('survives a stop that fails', async () => {
        stop.mockReturnValue(throwError(() => new Error('nope')));
        const controller = new AbortController();
        await microvm(controller.signal);

        controller.abort('bye');
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(stop).toHaveBeenCalledTimes(1);
      });

      it("leaves lambda, which can't stop", async () => {
        const controller = new AbortController();
        await Sandbox.create({ runtime: 'aws.lambda', signal: controller.signal });

        expect(() => controller.abort('bye')).not.toThrow();
        expect(stop).not.toHaveBeenCalled();
      });
    });

    it('aborts a command on lambda', async () => {
      jest.spyOn(LambdaFunction.prototype, 'exec').mockReturnValue(NEVER);
      const controller = new AbortController();
      const sandbox = await Sandbox.create({ runtime: 'aws.lambda', signal: controller.signal });
      const command = sandbox.runCommand('sleep', ['60']);

      controller.abort('bye');

      await expect(command).rejects.toBe('bye');
    });
  });

  describe('ctrl+c during a command', () => {
    const listeners = process.listeners('SIGINT');
    let kill: jest.SpyInstance;
    let stop: jest.SpyInstance;

    const microvm = async (): Promise<Sandbox> => {
      jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });
      jest.spyOn(MicrovmCompute.prototype, 'exec').mockReturnValue(NEVER);
      return Sandbox.create({ runtime: 'aws.microvm' });
    };

    const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

    beforeEach(() => {
      process.removeAllListeners('SIGINT');
      kill = jest.spyOn(process, 'kill').mockReturnValue(true);
      stop = jest.spyOn(MicrovmCompute.prototype, 'stop').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });
    });

    afterEach(() => {
      process.removeAllListeners('SIGINT');
      listeners.forEach((listener) => process.on('SIGINT', listener));
    });

    it('stops the sandbox, then exits as usual', async () => {
      const sandbox = await microvm();
      void sandbox.runCommand('sleep', ['60']);
      await settled();

      process.emit('SIGINT');
      await settled();

      expect(stop).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
    });

    it('still exits when stop fails', async () => {
      stop.mockReturnValue(throwError(() => new Error('nope')));
      const sandbox = await microvm();
      void sandbox.runCommand('sleep', ['60']);
      await settled();

      process.emit('SIGINT');
      await settled();

      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
    });

    it("rejects with the command's own failure", async () => {
      const failed = new Subject<never>();
      jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });
      jest.spyOn(MicrovmCompute.prototype, 'exec').mockReturnValue(failed);
      const sandbox = await Sandbox.create({ runtime: 'aws.microvm' });
      const command = sandbox.runCommand('sleep', ['60']);
      await settled();

      process.emit('SIGINT');
      failed.error(new Error('Sandbox stopped'));

      await expect(command).rejects.toThrow('Sandbox stopped');
    });

    it("leaves the exit to a host's own handler", async () => {
      const host = jest.fn();
      const sandbox = await microvm();
      void sandbox.runCommand('sleep', ['60']);
      await settled();
      process.on('SIGINT', host);

      process.emit('SIGINT');
      await settled();

      expect(stop).toHaveBeenCalledTimes(1);
      expect(host).toHaveBeenCalledTimes(1);
      expect(kill).not.toHaveBeenCalled();
    });

    it('lets go after the first, so a second quits', async () => {
      const sandbox = await microvm();
      void sandbox.runCommand('sleep', ['60']);
      await settled();

      process.emit('SIGINT');

      expect(process.listenerCount('SIGINT')).toBe(0);
    });

    it('listens only while a command runs', async () => {
      jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });
      const exec = { cmdId: 'c', exitCode: 0, frames: EMPTY, wait: async () => exec } as unknown as ExecFinished;
      jest.spyOn(MicrovmCompute.prototype, 'exec').mockReturnValue(of(exec));
      const sandbox = await Sandbox.create({ runtime: 'aws.microvm' });

      expect(process.listenerCount('SIGINT')).toBe(0);
      await sandbox.runCommand('echo', ['hi']);

      expect(process.listenerCount('SIGINT')).toBe(0);
    });

    it("leaves Ctrl+C alone where a sandbox can't stop", async () => {
      jest.spyOn(LambdaFunction.prototype, 'exec').mockReturnValue(NEVER);
      const sandbox = await Sandbox.create({ runtime: 'aws.lambda' });
      void sandbox.runCommand('sleep', ['60']);
      await settled();

      expect(process.listenerCount('SIGINT')).toBe(0);
    });
  });

  describe('list', () => {
    const IMAGE = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:box-bcdf2';
    const OTHER = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:not-rowdy';
    const STARTED = new Date('2026-11-07T21:00:00.000Z');

    const functions = (): jest.SpyInstance =>
      jest.spyOn(LambdaClient.prototype, 'send').mockImplementation(((command: { input: { Marker?: string } }) =>
        Promise.resolve(
          command.input.Marker
            ? {
                Functions: [
                  {
                    FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:app',
                    FunctionName: 'app',
                    Environment: { Variables: {} },
                  },
                ],
              }
            : {
                Functions: [
                  {
                    FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:sandbox-ghjk4',
                    FunctionName: 'sandbox-ghjk4',
                    Environment: { Variables: { ROWDY_SANDBOX: 'true' } },
                  },
                ],
                NextMarker: 'next',
              }
        )) as never);

    const microvms = (): jest.SpyInstance =>
      jest.spyOn(LambdaMicrovmsClient.prototype, 'send').mockImplementation(((command: {
        constructor: { name: string };
        input: { Resource?: string };
      }) => {
        switch (command.constructor.name) {
          case 'ListMicrovmsCommand':
            return Promise.resolve({
              items: [
                { microvmId: 'gone', imageArn: IMAGE, state: 'TERMINATED', startedAt: new Date(0) },
                { microvmId: 'up', imageArn: IMAGE, state: 'RUNNING', startedAt: STARTED },
              ],
            });
          case 'ListMicrovmImagesCommand':
            return Promise.resolve({
              items: [
                { imageArn: IMAGE, name: 'box-bcdf2' },
                { imageArn: OTHER, name: 'not-rowdy' },
              ],
            });
          case 'ListTagsCommand':
            return Promise.resolve({
              Tags:
                command.input.Resource === IMAGE
                  ? { 'run.rowdy.aws': 'microvm', 'run.rowdy.timeout': '600', 'run.rowdy.meta.sub': 'github:1' }
                  : {},
            });
          default:
            return Promise.reject(new Error(`unexpected ${command.constructor.name}`));
        }
      }) as never);

    it('finds sandboxes on every runtime, and only sandboxes', async () => {
      functions();
      microvms();

      const found = await Sandbox.list();

      expect(found).toHaveLength(2);
      expect(found).toEqual(
        expect.arrayContaining([
          {
            sandboxId: IMAGE,
            name: 'box-bcdf2',
            runtime: 'aws.microvm',
            running: true,
            startedAt: STARTED,
            stopsAt: new Date(STARTED.getTime() + 600_000),
            meta: { sub: 'github:1' },
          },
          {
            sandboxId: 'arn:aws:lambda:us-east-1:123456789012:function:sandbox-ghjk4',
            name: 'sandbox-ghjk4',
            runtime: 'aws.lambda',
            meta: {},
          },
        ])
      );
    });

    it('says a microVM with no VM up is not running', async () => {
      microvms().mockImplementationOnce((() => Promise.resolve({ items: [] })) as never);

      const [found] = await Sandbox.list({ runtime: 'aws.microvm' });

      expect(found).toMatchObject({ running: false, startedAt: undefined, stopsAt: undefined });
    });

    it('asks only the runtime it was given', async () => {
      const lambda = functions();
      microvms();

      await Sandbox.list({ runtime: 'aws.microvm' });

      expect(lambda).not.toHaveBeenCalled();
    });

    it('keeps only sandboxes whose meta has every entry asked for', async () => {
      functions();
      microvms();

      const found = await Sandbox.list({ meta: { sub: 'github:1' } });

      expect(found.map(({ name, meta }) => ({ name, meta }))).toEqual([
        { name: 'box-bcdf2', meta: { sub: 'github:1' } },
      ]);
    });

    it('rejects on abort', async () => {
      functions();
      microvms();

      await expect(Sandbox.list({ signal: AbortSignal.abort('stop') })).rejects.toBe('stop');
    });
  });

  describe('errors', () => {
    const throttled = (): Error =>
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } });

    it('say what a person can do next', async () => {
      jest.spyOn(MicrovmCompute.prototype, 'create').mockReturnValue(throwError(throttled));

      await expect(Sandbox.create()).rejects.toThrow('Rate exceeded Retrying may help.');
    });

    it('keep their class', async () => {
      await expect(Sandbox.create({ runtime: 'aws.lambda', memory: 1 })).rejects.toBeInstanceOf(RangeError);
    });

    it('say it on a command too', async () => {
      jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });
      jest.spyOn(MicrovmCompute.prototype, 'exec').mockReturnValue(throwError(throttled));
      const sandbox = await Sandbox.create();

      await expect(sandbox.runCommand('true')).rejects.toThrow('Rate exceeded Retrying may help.');
    });
  });

  describe('files', () => {
    const microvm = (): void => {
      jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });
    };

    it('writes each file in order, a string as UTF-8', async () => {
      microvm();
      const write = jest.spyOn(MicrovmCompute.prototype, 'writeFile').mockReturnValue(of(undefined));
      const sandbox = await Sandbox.create();
      const bytes = new Uint8Array([0, 255]);

      await sandbox.writeFiles([
        { path: 'a.txt', content: 'hé' },
        { path: 'b.bin', content: bytes, mode: 0o644 },
      ]);

      expect(write.mock.calls.map(([path, content, mode]) => [path, Buffer.from(content), mode])).toEqual([
        ['a.txt', Buffer.from('hé'), undefined],
        ['b.bin', Buffer.from(bytes), 0o644],
      ]);
    });

    it('writes nothing for no files', async () => {
      microvm();
      const write = jest.spyOn(MicrovmCompute.prototype, 'writeFile');
      const sandbox = await Sandbox.create();

      await expect(sandbox.writeFiles([])).resolves.toBeUndefined();
      expect(write).not.toHaveBeenCalled();
    });

    it.each([
      [{ path: 'x.txt', cwd: '/app' }, '/app/x.txt'],
      [{ path: '/etc/hosts', cwd: '/app' }, '/etc/hosts'],
      [{ path: 'x.txt' }, 'x.txt'],
    ])('reads %j from %s', async (file, expected) => {
      microvm();
      const read = jest.spyOn(MicrovmCompute.prototype, 'readFile').mockReturnValue(of(Buffer.from('hi')));
      const sandbox = await Sandbox.create();

      await expect(sandbox.readFileToBuffer(file)).resolves.toEqual(Buffer.from('hi'));
      expect(read.mock.calls[0]![0]).toBe(expected);
    });

    it('reads a range', async () => {
      microvm();
      const read = jest.spyOn(MicrovmCompute.prototype, 'readFile').mockReturnValue(of(Buffer.from('hi')));
      const sandbox = await Sandbox.create();

      await sandbox.readFileToBuffer({ path: 'x.txt', offset: 5, length: 2 });

      expect(read.mock.calls[0]![1]).toEqual({ offset: 5, length: 2 });
    });

    it('resolves to null for a file that is not there', async () => {
      microvm();
      jest.spyOn(MicrovmCompute.prototype, 'readFile').mockReturnValue(of(null));
      const sandbox = await Sandbox.create();

      await expect(sandbox.readFileToBuffer({ path: 'missing' })).resolves.toBeNull();
    });

    it('makes a directory', async () => {
      microvm();
      const mkDir = jest.spyOn(MicrovmCompute.prototype, 'mkDir').mockReturnValue(of(undefined));
      const sandbox = await Sandbox.create();

      await sandbox.mkDir('cache');

      expect(mkDir.mock.calls[0]![0]).toBe('cache');
    });

    it.each([
      ['writeFiles', (sandbox: Sandbox) => sandbox.writeFiles([{ path: 'a', content: 'x' }])],
      ['readFileToBuffer', (sandbox: Sandbox) => sandbox.readFileToBuffer({ path: 'a' })],
      ['mkDir', (sandbox: Sandbox) => sandbox.mkDir('a')],
    ])('rejects %s on Lambda', async (_, call) => {
      const sandbox = await Sandbox.create({ runtime: 'aws.lambda' });

      await expect(call(sandbox)).rejects.toThrow(new SandboxError('files are not implemented on runtime aws.lambda'));
    });
  });

  describe('a detached command', () => {
    const running = (): { frames: Subject<ExecFrame>; exec: jest.SpyInstance } => {
      jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });
      const frames = new Subject<ExecFrame>();
      const exec = jest.spyOn(MicrovmCompute.prototype, 'exec').mockReturnValue(execOf(() => 'c', frames));
      return { frames, exec };
    };

    it('resolves once started, and keeps writing output until it exits', async () => {
      const { frames, exec } = running();
      const sandbox = await Sandbox.create();
      const stdout = new PassThrough();
      const written: string[] = [];
      stdout.on('data', (chunk) => written.push(String(chunk)));

      const command = await sandbox.runCommand({ cmd: 'sleep', detached: true, stdout });

      expect(command.exitCode).toBeUndefined();
      expect(exec.mock.calls[0]![0].spec).toMatchObject({ cmd: 'sleep', detached: true });
      frames.next({ stream: EXEC_STREAM.STDOUT, payload: Buffer.from('later') });
      frames.next({ stream: EXEC_STREAM.EXIT, payload: Buffer.from('{"code":0}') });
      frames.complete();
      await expect(command.wait()).resolves.toMatchObject({ exitCode: 0 });
      expect(written.join('')).toBe('later');
    });

    it('lets go of the command on abort, without stopping anything', async () => {
      const { frames } = running();
      const stop = jest.spyOn(MicrovmCompute.prototype, 'stop');
      const sandbox = await Sandbox.create();
      const controller = new AbortController();

      await sandbox.runCommand({ cmd: 'sleep', detached: true, signal: controller.signal });
      expect(frames.observed).toBe(true);
      controller.abort();

      expect(frames.observed).toBe(false);
      expect(stop).not.toHaveBeenCalled();
    });

    it('is refused on Lambda, before anything is invoked', async () => {
      const invoke = jest.spyOn(LambdaFunction.prototype, 'exec');
      const sandbox = await Sandbox.create({ runtime: 'aws.lambda' });

      await expect(sandbox.runCommand({ cmd: 'sleep', detached: true })).rejects.toThrow(
        new SandboxError('detached is not implemented on runtime aws.lambda')
      );
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('stops its compute', async () => {
      const stop = jest.spyOn(MicrovmCompute.prototype, 'stop').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });
      jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });
      const sandbox = await Sandbox.create({ runtime: 'aws.microvm' });

      await expect(sandbox.stop()).resolves.toBeUndefined();

      expect(stop).toHaveBeenCalledTimes(1);
    });

    it('rejects on lambda for now', async () => {
      const sandbox = await Sandbox.create({ runtime: 'aws.lambda' });

      await expect(sandbox.stop()).rejects.toThrow('stop is not implemented on runtime aws.lambda');
    });
  });

  describe('events', () => {
    const step = {
      type: 'create',
      lifecycle: 'creating',
      client: 'IAMClient',
      action: 'CreateRole',
      name: 'role',
    } as const;
    const event = { source: 'cdk', message: 'CreateRole: creating', ...step };

    const emitting = (): void => {
      observe.mockImplementation(function (this: LambdaFunction) {
        this['emitted'].next(step);
        return of(this);
      });
    };

    it('shows the build to a caller who subscribes before awaiting', async () => {
      emitting();
      const seen: unknown[] = [];

      const creating = Sandbox.create({ runtime: 'aws.lambda' });
      creating.events().subscribe((emitted) => seen.push(emitted));
      await creating;

      expect(seen).toEqual([event]);
    });

    it('still resolves to the sandbox', async () => {
      const sandbox = await Sandbox.create({ runtime: 'aws.lambda' });

      expect(sandbox).toBeInstanceOf(SandboxImpl);
    });

    it('still rejects for options out of range', async () => {
      await expect(Sandbox.create({ runtime: 'aws.lambda', memory: 1 })).rejects.toThrow(RangeError);
    });

    it('shows a get to a caller who subscribes before awaiting', async () => {
      jest.spyOn(LambdaCompute.prototype, 'attach').mockImplementation(function (this: LambdaCompute) {
        return this['lambda$'].pipe(
          tap((lambda) => lambda['emitted'].next(step)),
          map(() => this)
        );
      });
      const seen: unknown[] = [];

      const getting = Sandbox.get({ sandboxId: 'arn:aws:lambda:us-east-1:123456789012:function:sandbox-bcdf245678' });
      getting.events().subscribe((emitted) => seen.push(emitted));
      await getting;

      expect(seen).toEqual([event]);
    });

    it('includes what the registry does', async () => {
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });
      const registry = new AwsRegistry(sandbox['environment']);
      const send = jest.fn(async () => ({}));
      registry['ecr'].config.requestHandler = { handle: send } as never;
      const seen: SandboxEvent[] = [];
      sandbox.events().subscribe((emitted) => seen.push(emitted));

      await registry['ecr'].send(new CreateRepositoryCommand({ repositoryName: 'acme' })).catch(() => {});

      expect(seen[0]).toEqual({
        source: 'cdk',
        message: 'CreateRepository: creating',
        type: 'create',
        lifecycle: 'creating',
        client: 'ECRClient',
        action: 'CreateRepository',
        name: 'acme',
      });
    });

    it('works as a promise', async () => {
      const settled = jest.fn();

      const reason = await Sandbox.create({ runtime: 'aws.lambda', memory: 1 })
        .catch((error) => error)
        .finally(settled);

      expect(reason).toBeInstanceOf(RangeError);
      expect(settled).toHaveBeenCalledTimes(1);
      await expect(Sandbox.create({ runtime: 'aws.lambda' }).then(({ constructor }) => constructor)).resolves.toBe(
        SandboxImpl
      );
    });

    it('starts from now on the sandbox', async () => {
      emitting();
      const sandbox = await Sandbox.create({ runtime: 'aws.lambda' });
      const seen: unknown[] = [];

      sandbox.events().subscribe((emitted) => seen.push(emitted));
      expect(seen).toEqual([]);

      lambdaOf(sandbox as SandboxImpl)['emitted'].next(step);

      expect(seen).toEqual([event]);
    });

    it('calls onEvent from the start of create', async () => {
      emitting();
      const onEvent = jest.fn();

      await Sandbox.create({ runtime: 'aws.lambda', onEvent });
      await new Promise(setImmediate);

      expect(onEvent).toHaveBeenCalledWith(event);
    });

    it('takes a promise of a callback', async () => {
      emitting();
      const onEvent = jest.fn();

      await Sandbox.create({ runtime: 'aws.lambda', onEvent: Promise.resolve(onEvent) });
      await new Promise(setImmediate);

      expect(onEvent).toHaveBeenCalledWith(event);
    });

    it('keeps order through a slow callback', async () => {
      const seen: string[] = [];
      let both: () => void = () => {};
      const handled = new Promise<void>((resolve) => (both = resolve));
      const sandbox = await SandboxImpl.create({
        runtime: 'aws.lambda',
        onEvent: async (emitted) => {
          await new Promise(setImmediate);
          seen.push(emitted.source === 'cdk' ? `${emitted.action}` : '');
          if (seen.length === 2) both();
        },
      });

      lambdaOf(sandbox)['emitted'].next({ ...step, action: 'First' });
      lambdaOf(sandbox)['emitted'].next({ ...step, action: 'Second' });
      await handled;

      expect(seen).toEqual(['First', 'Second']);
    });

    it('survives a callback that throws', async () => {
      emitting();
      const onEvent = jest.fn(() => {
        throw new Error('oops');
      });
      const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

      const sandbox = await Sandbox.create({ runtime: 'aws.lambda', onEvent });
      await new Promise(setImmediate);

      expect(sandbox).toBeInstanceOf(SandboxImpl);
      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalled();
    });

    it('keeps onEvent out of the name', async () => {
      const name = jest.spyOn(LambdaFunction.prototype, 'withName');

      await Sandbox.create({ runtime: 'aws.lambda' });
      await Sandbox.create({ runtime: 'aws.lambda', onEvent: () => {} });

      expect(name.mock.calls[1]).toEqual(name.mock.calls[0]);
    });

    describe('runCommand', () => {
      const running = async (sandbox: SandboxImpl): Promise<void> => {
        const exec = { cmdId: 'c', exitCode: 0, frames: EMPTY, wait: async () => exec } as unknown as ExecFinished;
        jest.spyOn(sandbox['compute'], 'exec').mockImplementation(() => {
          lambdaOf(sandbox)['emitted'].next(step);
          return of(exec);
        });
      };

      it('calls onEvent with what happens during the command only', async () => {
        const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });
        lambdaOf(sandbox)['emitted'].next({ ...step, action: 'Before' });
        await running(sandbox);
        const onEvent = jest.fn();

        await sandbox.runCommand({ cmd: 'ls', onEvent });
        await new Promise(setImmediate);

        expect(onEvent.mock.calls).toEqual([[event]]);
      });

      it('takes onEvent as an option too', async () => {
        const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });
        await running(sandbox);
        const onEvent = jest.fn();

        await sandbox.runCommand('ls', [], { onEvent });
        await new Promise(setImmediate);

        expect(onEvent).toHaveBeenCalledTimes(1);
      });

      it('stops calling after the command', async () => {
        const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });
        await running(sandbox);
        const onEvent = jest.fn();

        await sandbox.runCommand({ cmd: 'ls', onEvent });
        await new Promise(setImmediate);
        lambdaOf(sandbox)['emitted'].next(step);
        await new Promise(setImmediate);

        expect(onEvent).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('tools', () => {
    const IMAGE = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:box-bcdf2';
    const exited = { stream: EXEC_STREAM.EXIT, payload: Buffer.from('{"code":0}') };
    const ctx = (): ServerContext =>
      ({ mcpReq: { signal: new AbortController().signal, notify: async () => {} } }) as unknown as ServerContext;

    // A microVM sandbox whose commands exit at once, and whose `create` waits for `ready` when given.
    const microvm = (ready?: Promise<void>, failure?: Error) => {
      const imageArn = function (this: MicrovmCompute): Observable<MicrovmCompute> {
        this['imageArn'] = IMAGE;
        return of(this);
      };
      jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute) {
        if (failure) return throwError(() => failure);
        return ready
          ? from(ready.then(() => imageArn.call(this))).pipe(switchMap((made) => made))
          : imageArn.call(this);
      });
      jest.spyOn(MicrovmCompute.prototype, 'attach').mockImplementation(imageArn);
      const stop = jest.spyOn(MicrovmCompute.prototype, 'stop').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });
      const exec = jest
        .spyOn(MicrovmCompute.prototype, 'exec')
        .mockImplementation(() => execOf(() => 'c', from([exited])));
      return { exec, stop };
    };

    describe("a sandbox's own", () => {
      it('runs on it, with no sandbox_id to give', async () => {
        const { exec } = microvm();
        const sandbox = await Sandbox.create();

        const tools = sandbox.tools();
        const run = tools.find(({ name }) => name === 'run_command')!;
        const result = await run.run(run.inputSchema.parse({ cmd: 'true' }), ctx());

        expect(tools.map(({ name }) => name)).toEqual([
          'run_command',
          'read_output',
          'read_file',
          'write_file',
          'make_directory',
          'stop_sandbox',
        ]);
        tools.forEach(({ inputSchema }) => expect(Object.keys(inputSchema.shape)).not.toContain('sandbox_id'));
        expect(result.structuredContent).toMatchObject({ exit_code: 0, timed_out: false });
        expect(exec).toHaveBeenCalledTimes(1);
      });

      it('are each named where create_sandbox and get_sandbox say what a sandbox comes with', async () => {
        microvm();
        const names = (await Sandbox.create()).tools().map(({ name }) => name);

        names.forEach((name) => expect(OWN_TOOLS).toContain(name));
        expect(createSandbox.description).toContain(OWN_TOOLS);
        expect(getSandbox.description).toContain(OWN_TOOLS);
      });

      it('leaves out files and stop_sandbox where the sandbox has neither', async () => {
        const sandbox = await Sandbox.create({ runtime: 'aws.lambda' });

        expect(sandbox.tools().map(({ name }) => name)).toEqual(['run_command', 'read_output']);
      });

      it('are there before the sandbox is, and a call waits for it', async () => {
        let built!: () => void;
        const { exec } = microvm(new Promise((resolve) => (built = resolve)));
        const creating = Sandbox.create();

        const run = creating.tools().find(({ name }) => name === 'run_command')!;
        const ran = run.run(run.inputSchema.parse({ cmd: 'true' }), ctx());
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(exec).not.toHaveBeenCalled();
        built();

        await expect(ran).resolves.toMatchObject({ structuredContent: { exit_code: 0 } });
      });

      it("make a failed build each call's error, not an unhandled rejection", async () => {
        microvm(undefined, new SandboxError('build failed'));
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        try {
          const run = Sandbox.create()
            .tools()
            .find(({ name }) => name === 'run_command')!;
          await new Promise((resolve) => setTimeout(resolve, 10));

          await expect(run.run(run.inputSchema.parse({ cmd: 'true' }), ctx())).rejects.toThrow('build failed');
          expect(unhandled).not.toHaveBeenCalled();
        } finally {
          process.off('unhandledRejection', unhandled);
        }
      });
    });

    // What a host serves first, each run with the SDK's factory.
    const factoryTools: Tool<SandboxFactory>[] = Object.values(mcp.tools.factory);
    const hostTool = (name: string) => factoryTools.find((each) => each.name === name)!;

    describe('registered on a server as they arrive', () => {
      const setup = () => {
        const { stop } = microvm();
        const removed: string[] = [];
        const registerTool = jest.fn((name: string, _config: unknown, _run: unknown) => ({
          remove: () => void removed.push(name),
        }));
        const host = new AbortController();
        const changed = jest.fn();
        const own = { registerTool };
        const call = (name: string, input: Record<string, unknown> = {}, server: unknown = own) => {
          const tool = hostTool(name);
          return tool.run(Sandbox, tool.inputSchema.parse(input), {
            ...ctx(),
            server,
            signal: host.signal,
            changed,
          } as never);
        };
        const registered = () => registerTool.mock.calls.map(([name]) => name);
        return { call, registerTool, registered, removed, host, stop, changed };
      };

      it("adds a new sandbox's own tools, named with its suffix", async () => {
        const { call, registered } = setup();

        await call('create_sandbox');

        expect(registered()).toEqual([
          'run_command_bcdf2',
          'read_output_bcdf2',
          'read_file_bcdf2',
          'write_file_bcdf2',
          'make_directory_bcdf2',
          'stop_sandbox_bcdf2',
        ]);
      });

      it('adds them once for the same sandbox', async () => {
        const { call, registered } = setup();

        await call('create_sandbox');
        await call('create_sandbox');

        expect(registered()).toHaveLength(6);
      });

      it('takes them off when stop_sandbox stops it, and adds them again after', async () => {
        const { call, registered, removed } = setup();

        await call('create_sandbox');
        await call('stop_sandbox', { sandbox_id: IMAGE });
        await call('create_sandbox');

        expect(removed).toEqual([
          'run_command_bcdf2',
          'read_output_bcdf2',
          'read_file_bcdf2',
          'write_file_bcdf2',
          'make_directory_bcdf2',
          'stop_sandbox_bcdf2',
        ]);
        expect(registered()).toHaveLength(12);
      });

      it("takes them off when the sandbox's own stop_sandbox stops it", async () => {
        const { call, registerTool, removed, stop } = setup();

        await call('create_sandbox');
        const [, , own] = registerTool.mock.calls.find(([name]) => name === 'stop_sandbox_bcdf2')!;
        await (own as (args: unknown, extra: unknown) => Promise<unknown>)({}, ctx());

        expect(stop).toHaveBeenCalled();
        expect(removed).toHaveLength(6);
      });

      it("takes them all off when the host's signal aborts", async () => {
        const { call, removed, host } = setup();

        await call('create_sandbox');
        host.abort();

        expect(removed).toHaveLength(6);
      });

      it('says the tools changed when they go on and when a stop takes them off, once each', async () => {
        const { call, changed } = setup();

        await call('create_sandbox');
        await call('create_sandbox');
        expect(changed).toHaveBeenCalledTimes(1);

        await call('stop_sandbox', { sandbox_id: IMAGE });
        await call('stop_sandbox', { sandbox_id: IMAGE });
        expect(changed).toHaveBeenCalledTimes(2);
      });

      it("says so when the sandbox's own stop_sandbox takes them off", async () => {
        const { call, registerTool, changed } = setup();

        await call('create_sandbox');
        const [, , own] = registerTool.mock.calls.find(([name]) => name === 'stop_sandbox_bcdf2')!;
        await (own as (args: unknown, extra: unknown) => Promise<unknown>)({}, ctx());

        expect(changed).toHaveBeenCalledTimes(2);
      });

      it("doesn't say so when the signal takes them off", async () => {
        const { call, changed, host } = setup();

        await call('create_sandbox');
        host.abort();

        expect(changed).toHaveBeenCalledTimes(1);
      });

      it('adds them to each server a call comes in on, and takes them off only the one stopped on', async () => {
        const { call, registered, removed } = setup();
        const other = {
          registerTool: jest.fn((name: string) => ({ remove: () => void removed.push(`other:${name}`) })),
        };

        await call('create_sandbox');
        await call('create_sandbox', {}, other);
        await call('stop_sandbox', { sandbox_id: IMAGE }, other);

        expect(registered()).toHaveLength(6);
        expect(other.registerTool).toHaveBeenCalledTimes(6);
        expect(removed).toHaveLength(6);
        expect(removed.every((name) => name.startsWith('other:'))).toBe(true);
      });

      it('registers nothing without a server', async () => {
        microvm();
        const create = hostTool('create_sandbox');

        await expect(create.run(Sandbox, create.inputSchema.parse({}), ctx())).resolves.toMatchObject({
          structuredContent: { sandbox_id: IMAGE },
        });
      });
    });

    describe("held to the host's options", () => {
      const call = (
        name: string,
        input: Record<string, unknown>,
        options: SandboxToolsOptions = {},
        signal?: AbortSignal
      ) => {
        const tool = hostTool(name);
        return tool.run(Sandbox, tool.inputSchema.parse(input), { ...ctx(), ...options, signal });
      };
      const creating = () =>
        jest
          .spyOn(SandboxImpl, 'create')
          .mockReturnValue(Object.assign(Promise.resolve({ sandboxId: IMAGE }), { events: () => EMPTY }) as never);
      const created = (create: ReturnType<typeof creating>) => create.mock.calls[0]![0] as SandboxOptions;
      const getting = () =>
        jest.spyOn(SandboxImpl, 'get').mockImplementation(() => Promise.reject(new SandboxError('found it')) as never);

      describe('out of outgoing requests', () => {
        const capped = () => new Error('Too many subrequests.');

        it('tells the model to make the same create_sandbox again', async () => {
          jest
            .spyOn(SandboxImpl, 'create')
            .mockImplementation(() => Object.assign(Promise.reject(capped()), { events: () => EMPTY }) as never);

          await expect(call('create_sandbox', {})).rejects.toThrow(
            'This host ran out of outgoing requests for one call. What finished is kept, so the same call goes on from there. Retrying may help.'
          );
        });

        it.each(['get_sandbox', 'stop_sandbox'])('leaves calling %s again to the model', async (name) => {
          jest.spyOn(SandboxImpl, 'get').mockImplementation(() => Promise.reject(capped()) as never);

          const error: Error = await call(name, { sandbox_id: IMAGE }).catch((e) => e);

          expect(error.message).toBe('This host ran out of outgoing requests for one call.');
        });
      });

      describe('create_sandbox', () => {
        it("passes the call's meta on, and the model's name as it gave it", async () => {
          const create = creating();

          await call('create_sandbox', { name: 'builds' }, { meta: { sub: 'github:1' } });

          expect(created(create)).toMatchObject({ name: 'builds', meta: { sub: 'github:1' } });
        });

        it("adds the call's layers, which the model can't name", async () => {
          const create = creating();
          const tool = hostTool('create_sandbox');

          await call('create_sandbox', {}, { layersFrom: ['tunneld/tunneld:latest'] });

          expect(created(create).layersFrom).toEqual(['tunneld/tunneld:latest']);
          expect(Object.keys(tool.inputSchema.shape)).not.toContain('layersFrom');
        });

        it("passes the host's logLevel, pollInterval and credentials, and the call's signal, on", async () => {
          const create = creating();
          const { signal } = new AbortController();
          const tool = hostTool('create_sandbox');

          const credentials = async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' });
          await call('create_sandbox', {}, { logLevel: 'error', pollInterval: 15000, credentials }, signal);

          expect(created(create)).toMatchObject({ logLevel: 'error', pollInterval: 15000, credentials, signal });
          expect(Object.keys(tool.inputSchema.shape)).not.toContain('pollInterval');
        });

        it.each([
          [{ memory: 1024 }, { memory: 2048 }, 'memory must be at most 1024 MB, got 2048'],
          [{ timeout: 60000 }, { timeout: 120000 }, 'timeout must be at most 60000 ms, got 120000'],
          [{ runtimes: ['aws.microvm' as const] }, { runtime: 'aws.lambda' }, 'runtime must be one of aws.microvm'],
        ])('refuses past the limits %j: %j', async (limits, input, message) => {
          const create = creating();

          await expect(call('create_sandbox', input, { limits })).rejects.toThrow(message);
          expect(create).not.toHaveBeenCalled();
        });

        it.each([
          [
            { memory: 1024, timeout: 60000 },
            { memory: 1024, timeout: 60000 },
            { memory: 1024, timeout: 60000 },
          ],
          [{ memory: 256, timeout: 60000 }, {}, { memory: 256, timeout: 60000 }],
          [{ memory: 8192, timeout: 3600000 }, {}, { memory: 512, timeout: 900000 }],
          [{ runtimes: ['aws.microvm' as const, 'aws.lambda' as const] }, {}, { runtime: 'aws.microvm' }],
        ])('under the limits %j, makes %j into %j', async (limits, input, expected) => {
          const create = creating();

          await call('create_sandbox', input, { limits });

          expect(created(create)).toMatchObject(expected);
        });
      });

      describe('a sandbox_id', () => {
        it.each(['stop_sandbox', 'get_sandbox'])(
          'is looked up by %s with the call meta, logLevel, pollInterval, credentials and signal',
          async (name) => {
            const get = getting();
            const { signal } = new AbortController();
            const meta = { sub: 'github:1' };
            const credentials = async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' });

            await expect(
              call(name, { sandbox_id: IMAGE }, { meta, logLevel: 'error', pollInterval: 15000, credentials }, signal)
            ).rejects.toThrow('found it');
            expect(get).toHaveBeenCalledWith({
              sandboxId: IMAGE,
              meta,
              logLevel: 'error',
              pollInterval: 15000,
              credentials,
              signal,
            });
          }
        );
      });

      describe('list_sandboxes', () => {
        const summaries: SandboxSummary[] = [
          { sandboxId: IMAGE, name: 'a-bcdf2', runtime: 'aws.microvm', meta: { sub: 'github:1' } },
          { sandboxId: FUNCTION_ARN, name: 'b-ghjk4', runtime: 'aws.lambda', meta: { sub: 'github:1' } },
        ];

        it("lists the call's meta, with its signal", async () => {
          const list = jest.spyOn(SandboxImpl, 'list').mockResolvedValue(summaries);
          const { signal } = new AbortController();

          await call('list_sandboxes', { runtime: 'aws.microvm' }, { meta: { sub: 'github:1' } }, signal);

          expect(list).toHaveBeenCalledWith({ runtime: 'aws.microvm', meta: { sub: 'github:1' }, signal });
        });

        it('lists only the runtimes the host allows', async () => {
          const list = jest
            .spyOn(SandboxImpl, 'list')
            .mockImplementation(async (options) => summaries.filter(({ runtime }) => runtime === options?.runtime));

          const { structuredContent } = await call('list_sandboxes', {}, { limits: { runtimes: ['aws.lambda'] } });

          expect(
            (structuredContent as { sandboxes: { runtime: string }[] }).sandboxes.map(({ runtime }) => runtime)
          ).toEqual(['aws.lambda']);
          expect(list.mock.calls.map(([options]) => options?.runtime)).toEqual(['aws.lambda']);
        });

        it('lists nothing for a runtime the host does not allow', async () => {
          const list = jest.spyOn(SandboxImpl, 'list').mockResolvedValue(summaries);

          const { structuredContent } = await call(
            'list_sandboxes',
            { runtime: 'aws.microvm' },
            { limits: { runtimes: ['aws.lambda'] } }
          );

          expect(structuredContent).toEqual({ sandboxes: [] });
          expect(list).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('sandboxId', () => {
    it('is the function arn', async () => {
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });
      lambdaOf(sandbox).State.FunctionArn = FUNCTION_ARN;

      expect(sandbox.sandboxId).toBe(FUNCTION_ARN);
    });

    it('throws before a function exists', async () => {
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });

      expect(() => sandbox.sandboxId).toThrow('Sandbox has no function');
    });
  });

  describe('runCommand', () => {
    const start = async (...events: Event[]): Promise<{ sandbox: SandboxImpl; send: jest.SpyInstance }> => {
      const send = jest.spyOn(LambdaClient.prototype, 'send');
      send.mockImplementation(() =>
        Promise.resolve({ $metadata: { requestId: 'req' }, EventStream: stream(...events) })
      );
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });
      lambdaOf(sandbox).State.FunctionArn = FUNCTION_ARN;
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
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });

      await expect(lambdaOf(sandbox)['invoker'].config.maxAttempts()).resolves.toBe(1);
    });

    it('takes its cmdId from where the function says it logs', async () => {
      const location = { logGroupName: '/aws/lambda/sandbox', logStreamName: '2026/11/07/[$LATEST]abc' };
      const { sandbox } = await start(
        payload(execFrame(EXEC_STREAM.LOG, Buffer.from(JSON.stringify(location)))),
        payload(execFrame(EXEC_STREAM.EXIT, Buffer.from('{"code":0}')))
      );

      const { cmdId } = await sandbox.runCommand('sh');

      expect(JSON.parse(Buffer.from(cmdId, 'base64url').toString())).toEqual({
        logGroupIdentifiers: [expect.stringMatching(/^arn:aws:logs:.+:log-group:\/aws\/lambda\/sandbox$/)],
        logStreamNamePrefixes: ['2026/11/07/[$LATEST]abc'],
        logEventFilterPattern: '"rowdy.exec" "req"',
      });
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
        const subscription = run(lambdaOf(sandbox)).subscribe((handle) => handles.push(handle));
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

        const exec = await lastValueFrom(run(lambdaOf(sandbox)));
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

        const subscription = run(lambdaOf(sandbox)).subscribe((handle) => handles.push(handle));
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
      const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda' });

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

  it('exposes only create, get and list', () => {
    expect(Object.keys(Sandbox).sort()).toEqual(['create', 'get', 'list']);
  });

  it('feeds its signal to its environment', async () => {
    const controller = new AbortController();
    const sandbox = await SandboxImpl.create({ runtime: 'aws.lambda', signal: controller.signal });

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

    it('connects to a microvm by its image arn', async () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox-box';
      const attach = jest.spyOn(MicrovmCompute.prototype, 'attach').mockImplementation(function (this: MicrovmCompute) {
        return of(this);
      });

      const sandbox = (await Sandbox.get({ sandboxId: arn })) as SandboxImpl;

      expect(sandbox['compute']).toBeInstanceOf(MicrovmCompute);
      expect(attach).toHaveBeenCalledWith(arn, undefined);
      expect(withArn).not.toHaveBeenCalled();
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

describe('credentials', () => {
  const IMAGE = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:box-bcdf2';
  const given = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token' };
  const credentials = jest.fn(async () => given);

  afterEach(() => {
    jest.restoreAllMocks();
    credentials.mockClear();
  });

  // The compute a create with these credentials makes.
  const created = async (asked: () => Promise<typeof given>): Promise<MicrovmCompute> => {
    const create = jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute) {
      Object.assign(this, { imageArn: IMAGE });
      return of(this);
    });
    await Sandbox.create({ runtime: 'aws.microvm', credentials: asked });
    return create.mock.contexts[0] as MicrovmCompute;
  };

  it("are what a sandbox's AWS clients act as, asked for once for all of them", async () => {
    const compute = await created(credentials);

    for (const client of ['iam', 'microvms', 's3', 'sts'] as const) {
      await expect(compute[client].config.credentials()).resolves.toMatchObject(given);
    }
    expect(credentials).toHaveBeenCalledTimes(1);
  });

  it('replay a failure to every client, without asking again', async () => {
    const failing = jest.fn(async () => given).mockRejectedValueOnce(new Error('no token'));
    const { credentials: replayed } = (await created(failing))['environment'];

    await expect(replayed!()).rejects.toThrow('no token');
    await expect(replayed!()).rejects.toThrow('no token');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('reach the image copy and the deploy on aws.lambda', async () => {
    const environment = new SandboxEnvironment(new Logger(), { credentials });
    const registry = new AwsRegistry(environment);
    const deployer = new LambdaFunction(
      'Sandbox',
      new LambdaImageService({
        log: environment.log,
        signal: environment.signal,
        name: environment.name,
        version: environment.version,
        credentials,
        rowdy: environment,
      })
    );

    await expect(registry['ecr'].config.credentials()).resolves.toMatchObject(given);
    await expect(deployer['lambda'].config.credentials()).resolves.toMatchObject(given);
  });

  it('go from create, get and list to the compute', async () => {
    const seen: unknown[] = [];
    jest.spyOn(MicrovmCompute.prototype, 'create').mockImplementation(function (this: MicrovmCompute) {
      seen.push(this['environment'].credentials);
      Object.assign(this, { imageArn: IMAGE });
      return of(this);
    });
    jest.spyOn(MicrovmCompute.prototype, 'attach').mockImplementation(function (this: MicrovmCompute) {
      seen.push(this['environment'].credentials);
      Object.assign(this, { imageArn: IMAGE });
      return of(this);
    });
    const list = jest.spyOn(MicrovmCompute, 'list').mockReturnValue(EMPTY);

    await Sandbox.create({ runtime: 'aws.microvm', credentials });
    await Sandbox.get({ sandboxId: IMAGE, credentials });
    await Sandbox.list({ runtime: 'aws.microvm', credentials });

    for (const replayed of seen as (() => Promise<unknown>)[]) {
      await expect(replayed()).resolves.toEqual(given);
    }
    expect(seen).toHaveLength(2);
    expect(list).toHaveBeenCalledWith(credentials);
  });

  it("stay undefined without them, for the AWS SDK's own chain", () => {
    expect(new SandboxEnvironment(new Logger()).credentials).toBeUndefined();
  });
});
