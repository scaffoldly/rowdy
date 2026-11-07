import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PassThrough } from 'stream';
import { Subject } from 'rxjs';
import { EXEC_LOG, EXEC_STREAM, ShellExit, ShellProxy, ShellResponse } from '../src/proxy/shell';

type Line = { cmd: string; seq: number; stream: number; data: string; dropped?: boolean };

describe('exec log', () => {
  const { chunk, limit } = EXEC_LOG;
  let lines: Line[];
  let write: jest.SpiedFunction<typeof process.stdout.write>;

  const start = (): { stdout: PassThrough; stderr: PassThrough; exit: Subject<ShellExit>; chunks: unknown[] } => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exit = new Subject<ShellExit>();
    const shell = Object.assign(exit, { fds: { stdout, stderr } }) as unknown as ShellResponse;
    const chunks: unknown[] = [];
    const response = { next: (chunk: unknown) => chunks.push(chunk), complete: () => {}, error: () => {} };
    ShellProxy.prototype['multiplex'].call({}, 'cmd-1', shell, response as never);
    return { stdout, stderr, exit, chunks };
  };

  const decoded = (stream: number): string =>
    lines
      .filter((line) => line.stream === stream)
      .map(({ data }) => Buffer.from(data, 'base64').toString())
      .join('');

  beforeEach(() => {
    lines = [];
    write = jest.spyOn(process.stdout, 'write').mockImplementation((text) => {
      lines.push(JSON.parse(`${text}`)[EXEC_LOG.key]);
      return true;
    });
  });

  afterEach(() => {
    write.mockRestore();
    Object.assign(EXEC_LOG, { chunk, limit });
  });

  it('logs each stream under the command, in order', () => {
    const { stdout, stderr, exit } = start();

    stdout.emit('data', Buffer.from('out'));
    stderr.emit('data', Buffer.from('err'));
    exit.next({ code: 3 });

    expect(lines.map(({ cmd, seq, stream }) => [cmd, seq, stream])).toEqual([
      ['cmd-1', 0, EXEC_STREAM.STDOUT],
      ['cmd-1', 1, EXEC_STREAM.STDERR],
      ['cmd-1', 2, EXEC_STREAM.EXIT],
    ]);
    expect(decoded(EXEC_STREAM.STDOUT)).toBe('out');
    expect(JSON.parse(decoded(EXEC_STREAM.EXIT))).toEqual({ code: 3 });
  });

  it('still sends every frame to the response', () => {
    const { stdout, chunks } = start();

    stdout.emit('data', Buffer.from('out'));

    expect(chunks).toHaveLength(1);
  });

  it('splits a big chunk so a line fits an event', () => {
    EXEC_LOG.chunk = 4;
    const { stdout } = start();

    stdout.emit('data', Buffer.from('0123456789'));

    expect(lines.map(({ data }) => Buffer.from(data, 'base64').toString())).toEqual(['0123', '4567', '89']);
  });

  it('stops logging at the limit, says so once, and still logs the exit', () => {
    EXEC_LOG.limit = 4;
    const { stdout, exit, chunks } = start();

    stdout.emit('data', Buffer.from('12345'));
    stdout.emit('data', Buffer.from('6789'));
    exit.next({ code: 0 });

    expect(lines.filter(({ dropped }) => dropped)).toHaveLength(1);
    expect(decoded(EXEC_STREAM.STDOUT)).toBe('12345');
    expect(decoded(EXEC_STREAM.EXIT)).toBe('{"code":0}');
    expect(chunks).toHaveLength(3);
  });
});
