import { LINUX_ERRNO, VfsServer, VfsAdapter, VfsError } from '../src/server';
import { connect } from 'net';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('VfsServer', () => {
  let dir: string;
  let socketPath: string;
  let server: VfsServer;
  let adapter: jest.Mocked<VfsAdapter>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rowdy-vfs-server-'));
    socketPath = join(dir, 'vfs.sock');
    adapter = {
      stat: jest.fn().mockResolvedValue(undefined),
      fetch: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue(undefined),
      open: jest.fn().mockResolvedValue(undefined),
      flush: jest.fn().mockResolvedValue(undefined),
      mkdir: jest.fn().mockResolvedValue(undefined),
      unlink: jest.fn().mockResolvedValue(undefined),
      rename: jest.fn().mockResolvedValue(undefined),
    };
    server = new VfsServer(adapter, { socket: socketPath });
  });

  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const request = (reqs: string | string[]): Promise<string[]> => {
    return new Promise((resolve, reject) => {
      const conn = connect(socketPath);
      let buffer = '';
      conn.on('data', (d) => {
        buffer += d.toString();
        // Just return chunks separated by newline. Since we send fixed strings, wait until all expected replies are in
      });
      conn.on('error', reject);
      conn.on('end', () => {
        resolve(buffer.split('\n').filter((l) => l.length > 0));
      });

      const lines = Array.isArray(reqs) ? reqs : [reqs];
      for (const l of lines) {
        conn.write(l + (l.endsWith('\n') ? '' : '\n'));
      }
      // Give server time to process
      setTimeout(() => conn.end(), 100);
    });
  };

  it('connects, writes request lines, asserts replies in order', async () => {
    await server.listen();

    // adapter throwing VfsError.code('ENOENT') -> errno 2
    adapter.stat.mockRejectedValueOnce(VfsError.code('ENOENT'));

    // a thrown node fs error -> errno 13
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    adapter.fetch.mockRejectedValueOnce(eacces);

    adapter.mkdir.mockResolvedValueOnce(undefined);

    const replies = await request([
      '{"op":"stat","path":"/vfs/no"}',
      '{"op":"fetch","path":"/vfs/denied"}',
      '{"op":"mkdir","path":"/vfs/ok"}',
    ]);

    expect(replies).toEqual(['{"ok":false,"errno":2}', '{"ok":false,"errno":13}', '{"ok":true}']);

    expect(adapter.stat).toHaveBeenCalledWith('/vfs/no');
    expect(adapter.fetch).toHaveBeenCalledWith('/vfs/denied');
    expect(adapter.mkdir).toHaveBeenCalledWith('/vfs/ok');
  });

  it('returns EINVAL for malformed JSON', async () => {
    await server.listen();
    const replies = await request('{malformed');
    expect(replies).toEqual(['{"ok":false,"errno":22}']); // EINVAL is 22
  });

  it('returns ENOSYS for unknown op', async () => {
    await server.listen();
    const replies = await request('{"op":"unknown","path":"/vfs"}');
    expect(replies).toEqual(['{"ok":false,"errno":' + LINUX_ERRNO.ENOSYS + '}']);
  });

  it('handles two requests in one chunk and one request split across chunks', async () => {
    await server.listen();
    const replies = await new Promise<string[]>((resolve, reject) => {
      const conn = connect(socketPath);
      let buffer = '';
      conn.on('data', (d) => {
        buffer += d.toString();
      });
      conn.on('error', reject);
      conn.on('end', () => resolve(buffer.split('\n').filter(Boolean)));

      // two requests in one chunk
      conn.write('{"op":"stat","path":"/vfs/1"}\n{"op":"stat","path":"/vfs/2"}\n');

      // split across chunks
      conn.write('{"op":"stat",');
      setTimeout(() => {
        conn.write('"path":"/vfs/3"}\n');
        setTimeout(() => conn.end(), 100);
      }, 50);
    });

    expect(replies).toEqual(['{"ok":true}', '{"ok":true}', '{"ok":true}']);
    expect(adapter.stat).toHaveBeenCalledTimes(3);
  });

  it('removes socket file on close', async () => {
    await server.listen();
    expect(existsSync(socketPath)).toBe(true);
    await server.close();
    expect(existsSync(socketPath)).toBe(false);
  });

  it('replaces a stale socket file on listen', async () => {
    writeFileSync(socketPath, 'stale');
    expect(existsSync(socketPath)).toBe(true);
    await server.listen();
    expect(existsSync(socketPath)).toBe(true);
  });
});
