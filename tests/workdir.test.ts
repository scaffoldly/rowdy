import { mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Environment, Logger } from '../src';

describe('working directory', () => {
  const start = process.cwd();
  afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(start);
  });

  const environment = (): { env: Environment; warnings: unknown[][] } => {
    const log = new Logger();
    const warnings: unknown[][] = [];
    jest.spyOn(log, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args);
      return log;
    });
    return { env: new Environment(log), warnings };
  };

  it('changes to the directory the command should run in', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rowdy-workdir-')));
    const { env, warnings } = environment();

    env['chdir'](dir);

    expect(process.cwd()).toBe(dir);
    expect(warnings).toEqual([]);
  });

  it('stays put and warns when the directory cannot be entered', () => {
    const { env, warnings } = environment();
    jest.spyOn(process, 'chdir').mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied, chdir '/home/nonroot'"), { code: 'EACCES' });
    });

    env['chdir']('/home/nonroot');

    expect(process.cwd()).toBe(start);
    expect(warnings).toEqual([
      [
        'Working Directory Unavailable',
        expect.objectContaining({ workdir: '/home/nonroot', cwd: start, error: 'EACCES' }),
      ],
    ]);
  });
});
