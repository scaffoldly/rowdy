import { Logger } from '@scaffoldly/rowdy';
import { Command, CommandFinished, Sandbox } from '@scaffoldly/rowdy/sandbox';
import { AxiosError, AxiosHeaders, InternalAxiosRequestConfig } from 'axios';
import { NEVER, Observable, of, Subject, throwError } from 'rxjs';
import { ROWDY_LAYERS } from '../src/api/internal/layers';
import { LambdaFunction } from '../src/aws/lambda/index';
import { SandboxImpl } from '../src/sandbox/internal/sandbox';

const NOT_IMPLEMENTED = 'not implemented';

// Compiled, not called: ts-jest fails the suite if the types drift from these shapes.
const _shapes = async (sandbox: Sandbox): Promise<void> => {
  const finished: CommandFinished = await sandbox.runCommand('echo', ['hello world']);
  const _exitCode: number = finished.exitCode;
  const _output: string = await finished.stdout();
  const detached: Command = await sandbox.runCommand({ cmd: 'sleep', args: ['60'], detached: true });
  const _waited: CommandFinished = await detached.wait();
  const _file: Buffer | null = await sandbox.readFileToBuffer({ path: 'out.txt' });
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
    ])('defaults to e2bdev/base with %s', async (_, options) => {
      const image = jest.spyOn(LambdaFunction.prototype, 'withImage');

      await SandboxImpl.create(options);

      expect(image).toHaveBeenCalledWith('e2bdev/base');
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

    it('leaves an unnamed function unnamed', async () => {
      const name = jest.spyOn(LambdaFunction.prototype, 'withName');

      await SandboxImpl.create();

      expect(name).not.toHaveBeenCalled();
    });

    it('applies its options to the function', async () => {
      const image = jest.spyOn(LambdaFunction.prototype, 'withImage');
      const name = jest.spyOn(LambdaFunction.prototype, 'withName');
      const memory = jest.spyOn(LambdaFunction.prototype, 'withMemory');
      const env = jest.spyOn(LambdaFunction.prototype, 'withEnvironment');

      await SandboxImpl.create({ image: 'busybox', name: 'box', memory: 512, env: { FOO: 'bar' } });

      expect(image).toHaveBeenCalledWith('busybox');
      expect(name).toHaveBeenCalledWith('box');
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

  it('compiles the documented example, which stops at the first unimplemented call', async () => {
    const main = async (): Promise<void> => {
      const sandbox = await Sandbox.create({ timeout: 15 * 60 * 1000 });

      await sandbox.runCommand({
        cmd: 'echo',
        args: ['hello world'],
        stdout: process.stdout,
        stderr: process.stderr,
      });
    };

    await expect(main()).rejects.toThrow(NOT_IMPLEMENTED);
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

  it('does not implement get', async () => {
    await expect(Sandbox.get({ sandboxId: 'sandbox' })).rejects.toThrow(NOT_IMPLEMENTED);
  });

  describe('an instance', () => {
    const sandbox: Sandbox = Object.create(SandboxImpl.prototype);

    it.each<[string, () => Promise<unknown>]>([
      ['runCommand', () => sandbox.runCommand('echo')],
      ['writeFiles', () => sandbox.writeFiles([{ path: 'a', content: Buffer.from('a') }])],
      ['readFileToBuffer', () => sandbox.readFileToBuffer({ path: 'a' })],
      ['mkDir', () => sandbox.mkDir('a')],
      ['stop', () => sandbox.stop()],
    ])('does not implement %s', async (_name, call) => {
      await expect(call()).rejects.toThrow(NOT_IMPLEMENTED);
    });

    it('has no extendTimeout', () => {
      expect('extendTimeout' in sandbox).toBe(false);
    });

    it('does not implement sandboxId', () => {
      expect(() => sandbox.sandboxId).toThrow(NOT_IMPLEMENTED);
    });
  });
});
