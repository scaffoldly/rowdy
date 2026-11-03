import { Command, CommandFinished, Sandbox } from '@scaffoldly/rowdy/sandbox';
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
      ['extendTimeout', () => sandbox.extendTimeout(1000)],
      ['stop', () => sandbox.stop()],
    ])('does not implement %s', async (_name, call) => {
      await expect(call()).rejects.toThrow(NOT_IMPLEMENTED);
    });

    it('does not implement sandboxId', () => {
      expect(() => sandbox.sandboxId).toThrow(NOT_IMPLEMENTED);
    });
  });
});
