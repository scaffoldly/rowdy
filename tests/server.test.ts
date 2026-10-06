import { LINUX_ERRNO, MountAdapter, VfsServer, VfsAdapter, VfsError } from '../src/server';
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

describe('MountAdapter', () => {
  const recorder = (name: string, calls: string[], optional = true): VfsAdapter => {
    const record =
      (op: string) =>
      async (...args: unknown[]): Promise<void> => {
        calls.push(`${name}.${op}(${args.join(',')})`);
      };
    return {
      stat: record('stat'),
      fetch: record('fetch'),
      list: record('list'),
      open: record('open'),
      flush: record('flush'),
      mkdir: record('mkdir'),
      unlink: record('unlink'),
      rename: record('rename'),
      ...(optional ? { revalidate: record('revalidate'), lock: record('lock'), unlock: record('unlock') } : {}),
    };
  };

  let calls: string[];
  let mounts: MountAdapter;

  beforeEach(() => {
    calls = [];
    mounts = new MountAdapter([
      { mountpoint: '/s3', adapter: recorder('s3', calls) },
      { mountpoint: '/s3/scratch', adapter: recorder('scratch', calls, false) },
      { mountpoint: '/data', adapter: recorder('data', calls) },
    ]);
  });

  it('routes each operation to the mount its path falls in', async () => {
    await mounts.stat('/s3/a.txt');
    await mounts.fetch('/data/b.txt');
    await mounts.list('/s3');
    await mounts.open('/data/c.txt', 577);
    await mounts.flush('/data/c.txt');
    await mounts.mkdir('/s3/dir');
    await mounts.unlink('/s3/dir');
    expect(calls).toEqual([
      's3.stat(/s3/a.txt)',
      'data.fetch(/data/b.txt)',
      's3.list(/s3)',
      'data.open(/data/c.txt,577)',
      'data.flush(/data/c.txt)',
      's3.mkdir(/s3/dir)',
      's3.unlink(/s3/dir)',
    ]);
  });

  it('gives a nested mount its own subtree and does not match lookalike prefixes', async () => {
    await mounts.stat('/s3/scratch/tmp.bin');
    await mounts.stat('/s3/scratchpad');
    await mounts.stat('/s3x/a');
    await mounts.stat('/elsewhere');
    expect(calls).toEqual(['scratch.stat(/s3/scratch/tmp.bin)', 's3.stat(/s3/scratchpad)']);
    expect(mounts.mountOf('/s3/scratch')?.mountpoint).toBe('/s3/scratch');
    expect(mounts.mountOf('/s3x')).toBeUndefined();
  });

  it('forwards the lock operations only to adapters that have them', async () => {
    await mounts.lock('/s3/db.sqlite');
    await mounts.revalidate('/s3/db.sqlite');
    await mounts.unlock('/s3/db.sqlite');
    await expect(mounts.lock('/s3/scratch/x')).resolves.toBeUndefined();
    expect(calls).toEqual(['s3.lock(/s3/db.sqlite)', 's3.revalidate(/s3/db.sqlite)', 's3.unlock(/s3/db.sqlite)']);
  });

  it('renames within a mount and answers EXDEV across mounts', async () => {
    await mounts.rename('/data/a', '/data/b');
    expect(calls).toEqual(['data.rename(/data/a,/data/b)']);
    await expect(mounts.rename('/s3/a', '/data/a')).rejects.toMatchObject({ errno: LINUX_ERRNO.EXDEV });
    await expect(mounts.rename('/s3/a', '/s3/scratch/a')).rejects.toMatchObject({ errno: LINUX_ERRNO.EXDEV });
    expect(calls).toHaveLength(1);
  });

  it('lists its adapters most specific first and rejects bad or duplicate mountpoints', () => {
    expect(mounts.adapters).toHaveLength(3);
    const a = recorder('a', []);
    expect(() => new MountAdapter([{ mountpoint: 'rel', adapter: a }])).toThrow('Invalid mountpoint');
    expect(() => new MountAdapter([{ mountpoint: '/a/', adapter: a }])).toThrow('Invalid mountpoint');
    expect(
      () =>
        new MountAdapter([
          { mountpoint: '/a', adapter: a },
          { mountpoint: '/a', adapter: a },
        ])
    ).toThrow("Mountpoint '/a' is declared twice");
  });
});
