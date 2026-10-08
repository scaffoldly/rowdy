import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { P9Client } from '../src/p9/client';
import { P9Server } from '../src/p9/server';
import { AT_REMOVEDIR, GETATTR, LOCK_STATUS, LOCK_TYPE, QTDIR, QTFILE, SETATTR, VERSION } from '../src/p9/wire';
import { LINUX_ERRNO, LocalAdapter, VfsAdapter, VfsError } from '../src/server';

const O_RDONLY = 0;
const O_WRONLY = 1;
const O_RDWR = 2;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;

/** A LocalAdapter that records which hooks were called with which virtual paths. */
class Recorder implements VfsAdapter {
  calls: string[] = [];
  fail = new Map<string, keyof typeof LINUX_ERRNO>();
  private hook(op: string, path: string): void {
    this.calls.push(`${op} ${path}`);
    const code = this.fail.get(`${op} ${path}`);
    if (code) {
      throw VfsError.code(code, `${op} ${path} refused`);
    }
  }
  async stat(path: string): Promise<void> {
    this.hook('stat', path);
  }
  async fetch(path: string): Promise<void> {
    this.hook('fetch', path);
  }
  async list(path: string): Promise<void> {
    this.hook('list', path);
  }
  async open(path: string, flags: number): Promise<void> {
    this.hook(`open(${flags})`, path);
  }
  async flush(path: string): Promise<void> {
    this.hook('flush', path);
  }
  async mkdir(path: string): Promise<void> {
    this.hook('mkdir', path);
  }
  async unlink(path: string): Promise<void> {
    this.hook('unlink', path);
  }
  async rename(from: string, to: string): Promise<void> {
    this.hook('rename', `${from} -> ${to}`);
  }
  async revalidate(path: string): Promise<void> {
    this.hook('revalidate', path);
  }
  async lock(path: string): Promise<void> {
    this.hook('lock', path);
  }
  async unlock(path: string): Promise<void> {
    this.hook('unlock', path);
  }
  async acquire(path: string): Promise<void> {
    this.hook('acquire', path);
  }
  async release(path: string): Promise<void> {
    this.hook('release', path);
  }
}

describe('P9Server', () => {
  let dir: string;
  let s3: Recorder;
  let scratch: VfsAdapter;
  let server: P9Server;
  let client: P9Client;
  let root: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rowdy-9p-'));
    mkdirSync(join(dir, 's3', 'db'), { recursive: true });
    writeFileSync(join(dir, 's3', 'db', 'nuss.sqlite'), 'sqlite bytes');
    writeFileSync(join(dir, 's3', 'readme.txt'), 'hello');
    mkdirSync(join(dir, 'scratch'));
    s3 = new Recorder();
    scratch = new LocalAdapter();
    server = await new P9Server(
      [
        { mountpoint: '/s3', backing: join(dir, 's3'), adapter: s3 },
        { mountpoint: '/scratch', backing: join(dir, 'scratch'), adapter: scratch },
      ],
      { socket: join(dir, 'vfs.sock') }
    ).listen();
    client = await new P9Client(server.socket).connect();
    await client.version();
    root = (await client.attach('/s3')).fid;
    s3.calls = [];
  });

  afterEach(async () => {
    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('negotiates the version and attaches a mount by its mountpoint', async () => {
    const c = await new P9Client(server.socket).connect();
    try {
      expect(await c.version(8192)).toEqual({ msize: 8192, version: VERSION });
      const { qid } = await c.attach('/scratch');
      expect(qid.type).toBe(QTDIR);
      await expect(c.attach('/nope')).rejects.toMatchObject({ errno: LINUX_ERRNO.ENOENT });
    } finally {
      c.close();
    }
  });

  it('walks with the stat hook on every step, answers partial walks, and hands out qids', async () => {
    const { fid, qids } = await client.walk(root, ['db', 'nuss.sqlite']);
    expect(qids.map((q) => q.type)).toEqual([QTDIR, QTFILE]);
    expect(s3.calls).toEqual(['stat /s3/db', 'stat /s3/db/nuss.sqlite']);
    await client.clunk(fid);

    const partial = await client.walk(root, ['db', 'missing', 'deeper']);
    expect(partial.qids).toHaveLength(1); // stopped at the first miss
    await expect(client.clunk(partial.fid)).rejects.toMatchObject({ errno: LINUX_ERRNO.EBADF }); // newfid never bound

    await expect(client.walk(root, ['missing'])).rejects.toMatchObject({ errno: LINUX_ERRNO.ENOENT });
    await expect(client.walk(root, ['readme.txt', 'x'])).rejects.toMatchObject({ errno: LINUX_ERRNO.ENOTDIR });
  });

  it('getattr re-checks the store and reports the backing file; .. never leaves the mount', async () => {
    await client.withFid(root, 'db/nuss.sqlite', async (fid) => {
      const attr = await client.getattr(fid, GETATTR.ALL);
      expect(attr.size).toBe(12n);
      expect(attr.qid.type).toBe(QTFILE);
      expect(attr.valid & GETATTR.SIZE).toBe(GETATTR.SIZE);
    });
    expect(s3.calls).toContain('stat /s3/db/nuss.sqlite');
    const up = await client.walk(root, ['..', '..', 'readme.txt']);
    expect(up.qids).toHaveLength(3);
    await client.clunk(up.fid);
  });

  it('opens for reading with the fetch hook and serves the bytes to a reading client', async () => {
    await client.withFid(root, 'readme.txt', async (fid) => {
      await client.lopen(fid, O_RDONLY);
      expect(await client.read(fid, 0n, 100)).toEqual(Buffer.from('hello'));
      expect(await client.read(fid, 1n, 2)).toEqual(Buffer.from('el'));
    });
    expect(s3.calls.filter((c) => c.startsWith('fetch'))).toEqual(['fetch /s3/readme.txt']);
    expect(s3.calls.filter((c) => c.startsWith('open'))).toEqual([]);
    expect(s3.calls.filter((c) => c.startsWith('flush'))).toEqual([]);
    // a reader is acquired at lopen and released at clunk, so the store knows the copy is in use
    expect(s3.calls.filter((c) => /^(acquire|release)/.test(c))).toEqual([
      'acquire /s3/readme.txt',
      'release /s3/readme.txt',
    ]);
  });

  it('opens for writing with the open hook and flushes once on fsync and once on clunk', async () => {
    await client.withFid(root, 'readme.txt', async (fid) => {
      await client.lopen(fid, O_RDWR);
      expect(await client.write(fid, 5n, Buffer.from(', world'))).toBe(7);
      await client.fsync(fid);
    });
    expect(readFileSync(join(dir, 's3', 'readme.txt'), 'utf8')).toBe('hello, world');
    expect(s3.calls).toEqual([
      'stat /s3/readme.txt',
      'fetch /s3/readme.txt',
      `open(${O_RDWR}) /s3/readme.txt`,
      'acquire /s3/readme.txt',
      'flush /s3/readme.txt', // fsync
      'flush /s3/readme.txt', // clunk
      'release /s3/readme.txt',
    ]);
  });

  it('creates files with lcreate: the fid becomes the file, O_TRUNC skips the fetch, O_EXCL fails on an existing object', async () => {
    const { fid } = await client.walk(root, []);
    await client.lcreate(fid, 'new.txt', O_WRONLY | O_TRUNC);
    await client.write(fid, 0n, Buffer.from('fresh'));
    await client.clunk(fid);
    expect(readFileSync(join(dir, 's3', 'new.txt'), 'utf8')).toBe('fresh');
    expect(s3.calls).toEqual([
      `open(${O_WRONLY | O_TRUNC | O_CREAT}) /s3/new.txt`,
      'acquire /s3/new.txt',
      'flush /s3/new.txt',
      'release /s3/new.txt',
    ]);

    s3.calls = [];
    const again = await client.walk(root, []);
    await expect(client.lcreate(again.fid, 'new.txt', O_WRONLY | O_CREAT | O_EXCL)).rejects.toMatchObject({
      errno: LINUX_ERRNO.EEXIST,
    });
    expect(s3.calls).toEqual(['fetch /s3/new.txt']); // the store was consulted before deciding
  });

  it('forwards the lock ladder by type: revalidate, lock, flush + unlock; a contended lease is BLOCKED', async () => {
    await client.withFid(root, 'db/nuss.sqlite', async (fid) => {
      await client.lopen(fid, O_RDWR);
      s3.calls = [];
      expect(await client.lock(fid, LOCK_TYPE.RDLCK)).toBe(LOCK_STATUS.SUCCESS);
      expect(await client.lock(fid, LOCK_TYPE.WRLCK)).toBe(LOCK_STATUS.SUCCESS);
      expect(await client.lock(fid, LOCK_TYPE.WRLCK)).toBe(LOCK_STATUS.SUCCESS); // re-entrant, no second lease
      expect(await client.lock(fid, LOCK_TYPE.RDLCK)).toBe(LOCK_STATUS.SUCCESS); // a downgrade: no revalidate while held
      expect(await client.lock(fid, LOCK_TYPE.UNLCK)).toBe(LOCK_STATUS.SUCCESS);
      expect(s3.calls).toEqual([
        'revalidate /s3/db/nuss.sqlite',
        'lock /s3/db/nuss.sqlite',
        'flush /s3/db/nuss.sqlite',
        'unlock /s3/db/nuss.sqlite',
      ]);
      s3.fail.set('lock /s3/db/nuss.sqlite', 'EAGAIN');
      expect(await client.lock(fid, LOCK_TYPE.WRLCK)).toBe(LOCK_STATUS.BLOCKED);
      expect((await client.getlock(fid, LOCK_TYPE.WRLCK)).type).toBe(LOCK_TYPE.UNLCK);
    });
  });

  it('holds one lease for every write lock on a file: the last holder to unlock gives it back', async () => {
    // Two processes on one instance: B's write lock is granted while A holds the lease, and A's
    // unlock must not give the lease back from under B.
    const a = (await client.walk(root, ['db', 'nuss.sqlite'])).fid;
    const b = (await client.walk(root, ['db', 'nuss.sqlite'])).fid;
    await client.lopen(a, O_RDWR);
    await client.lopen(b, O_RDWR);
    s3.calls = [];
    expect(await client.lock(a, LOCK_TYPE.WRLCK)).toBe(LOCK_STATUS.SUCCESS);
    expect(await client.lock(b, LOCK_TYPE.WRLCK)).toBe(LOCK_STATUS.SUCCESS);
    expect(await client.lock(a, LOCK_TYPE.UNLCK)).toBe(LOCK_STATUS.SUCCESS);
    expect(s3.calls).toEqual(['lock /s3/db/nuss.sqlite', 'flush /s3/db/nuss.sqlite']);
    expect(await client.lock(b, LOCK_TYPE.UNLCK)).toBe(LOCK_STATUS.SUCCESS);
    expect(s3.calls).toEqual([
      'lock /s3/db/nuss.sqlite',
      'flush /s3/db/nuss.sqlite',
      'flush /s3/db/nuss.sqlite',
      'unlock /s3/db/nuss.sqlite',
    ]);

    // and a clunk with a write lock held counts as that holder's unlock
    s3.calls = [];
    await client.lock(a, LOCK_TYPE.WRLCK);
    await client.lock(b, LOCK_TYPE.WRLCK);
    await client.clunk(a);
    expect(s3.calls.filter((c) => /^(lock|unlock)/.test(c))).toEqual(['lock /s3/db/nuss.sqlite']);
    await client.clunk(b);
    expect(s3.calls.filter((c) => /^(lock|unlock)/.test(c))).toEqual([
      'lock /s3/db/nuss.sqlite',
      'unlock /s3/db/nuss.sqlite',
    ]);
  });

  it('gives the lease back when a client vanishes with a write lock held', async () => {
    const c = await new P9Client(server.socket).connect();
    await c.version();
    const r = (await c.attach('/s3')).fid;
    const { fid } = await c.walk(r, ['db', 'nuss.sqlite']);
    await c.lopen(fid, O_RDWR);
    await c.lock(fid, LOCK_TYPE.WRLCK);
    s3.calls = [];
    c.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(s3.calls).toEqual(['flush /s3/db/nuss.sqlite', 'unlock /s3/db/nuss.sqlite', 'release /s3/db/nuss.sqlite']);
  });

  it('lists a directory with the list hook, including . and .., and paginates by offset', async () => {
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(dir, 's3', `file-${String(i).padStart(2, '0')}.txt`), 'x');
    }
    const { fid } = await client.walk(root, []);
    s3.calls = [];
    await client.lopen(fid, O_RDONLY);
    await client.fsync(fid);
    expect(s3.calls.filter((c) => c.startsWith('list'))).toEqual([]); // open + fsync of a directory: no listing
    const page = await client.readdir(fid, 0n, 300);
    expect(page.length).toBeGreaterThan(2);
    expect(page.length).toBeLessThan(44);
    expect(page.slice(0, 2).map((e) => e.name)).toEqual(['.', '..']);
    const all = await client.readdirAll(fid);
    expect(all.map((e) => e.name).sort()).toEqual(
      [
        '.',
        '..',
        'db',
        'readme.txt',
        ...Array.from({ length: 40 }, (_, i) => `file-${String(i).padStart(2, '0')}.txt`),
      ].sort()
    );
    expect(all.find((e) => e.name === 'db')?.qid.type).toBe(QTDIR);
    expect(s3.calls.filter((c) => c.startsWith('list'))).toEqual(['list /s3']); // once, at the first readdir; rewinds re-read the directory only
    await client.clunk(fid);
  });

  it('mkdir, unlinkat and renameat run the backing operation and then the hook', async () => {
    const { fid } = await client.walk(root, []);
    expect((await client.mkdir(fid, 'photos')).type).toBe(QTDIR);
    expect(existsSync(join(dir, 's3', 'photos'))).toBe(true);
    const photos = await client.walk(root, ['photos']);
    await expect(client.renameat(fid, 'readme.txt', fid, 'photos/readme.txt')).rejects.toMatchObject({
      errno: LINUX_ERRNO.EINVAL, // names are single components
    });
    await client.renameat(fid, 'readme.txt', photos.fid, 'readme.txt');
    expect(existsSync(join(dir, 's3', 'photos', 'readme.txt'))).toBe(true);
    await expect(client.unlinkat(fid, 'photos', AT_REMOVEDIR)).rejects.toMatchObject({ errno: LINUX_ERRNO.ENOTEMPTY });
    await client.unlinkat(photos.fid, 'readme.txt');
    await client.unlinkat(fid, 'photos', AT_REMOVEDIR);
    expect(existsSync(join(dir, 's3', 'photos'))).toBe(false);
    expect(s3.calls.filter((c) => !c.startsWith('stat'))).toEqual([
      'mkdir /s3/photos',
      'rename /s3/readme.txt -> /s3/photos/readme.txt',
      'unlink /s3/photos/readme.txt',
      'unlink /s3/photos',
    ]);
    await client.clunk(fid);
    await client.clunk(photos.fid);
  });

  it('refuses a rename or link across mounts with EXDEV', async () => {
    const other = (await client.attach('/scratch')).fid;
    const s3root = await client.walk(root, []);
    await expect(client.renameat(s3root.fid, 'readme.txt', other, 'readme.txt')).rejects.toMatchObject({
      errno: LINUX_ERRNO.EXDEV,
    });
    expect(existsSync(join(dir, 's3', 'readme.txt'))).toBe(true);
    await client.clunk(s3root.fid);
    await client.clunk(other);
  });

  it('setattr: a truncate is a write (open hook, then flush); chmod and utimes touch the backing file', async () => {
    await client.withFid(root, 'readme.txt', async (fid) => {
      s3.calls = [];
      await client.setattr(fid, { valid: SETATTR.SIZE, size: 2n });
      expect(readFileSync(join(dir, 's3', 'readme.txt'), 'utf8')).toBe('he');
      await client.setattr(fid, { valid: SETATTR.MODE, mode: 0o600 });
      expect((await client.getattr(fid)).mode & 0o777).toBe(0o600);
      await client.setattr(fid, { valid: SETATTR.MTIME | SETATTR.MTIME_SET, mtime: { sec: 1700000000n, nsec: 0n } });
      expect((await client.getattr(fid)).mtime.sec).toBe(1700000000n);
    });
    expect(s3.calls.filter((c) => !c.startsWith('stat'))).toEqual([
      `open(${O_WRONLY}) /s3/readme.txt`,
      'flush /s3/readme.txt',
    ]);
  });

  it('symlinks and readlink keep the target as written; statfs answers for the backing filesystem', async () => {
    const { fid } = await client.walk(root, []);
    await client.symlink(fid, 'lnk', '/s3/readme.txt');
    const target = await client.withFid(root, 'lnk', (f) => client.readlink(f));
    expect(target).toBe('/s3/readme.txt');
    symlinkSync('/elsewhere', join(dir, 's3', 'dangling'));
    const dangling = await client.walk(root, ['dangling']); // lstat, so a dangling link still walks
    expect(dangling.qids[0]!.type).toBe(0x02);
    expect((await client.statfs(fid)).namelen).toBe(255);
    await client.clunk(fid);
    await client.clunk(dangling.fid);
  });

  it('turns adapter failures into Rlerror with the Linux errno and leaves the backing file alone', async () => {
    s3.fail.set('fetch /s3/readme.txt', 'EACCES');
    await client.withFid(root, 'readme.txt', async (fid) => {
      await expect(client.lopen(fid, O_RDONLY)).rejects.toMatchObject({ errno: LINUX_ERRNO.EACCES });
    });
    s3.fail.delete('fetch /s3/readme.txt');
    s3.fail.set('flush /s3/readme.txt', 'ESTALE');
    const { fid } = await client.walk(root, ['readme.txt']);
    await client.lopen(fid, O_RDWR);
    await client.write(fid, 0n, Buffer.from('X'));
    await expect(client.fsync(fid)).rejects.toMatchObject({ errno: LINUX_ERRNO.ESTALE });
    await expect(client.clunk(fid)).rejects.toMatchObject({ errno: LINUX_ERRNO.ESTALE }); // and the fid is gone regardless
    await expect(client.clunk(fid)).rejects.toMatchObject({ errno: LINUX_ERRNO.EBADF });
  });

  it('answers correctly even when the onRequest observer throws', async () => {
    const observed: string[] = [];
    const throwing = await new P9Server([{ mountpoint: '/s3', backing: join(dir, 's3'), adapter: s3 }], {
      socket: join(dir, 'throwing.sock'),
      onRequest: (request): never => {
        observed.push(String(request.type));
        throw new TypeError('Do not know how to serialize a BigInt');
      },
    }).listen();
    const c = await new P9Client(throwing.socket).connect();
    try {
      await c.version();
      const r = (await c.attach('/s3')).fid;
      expect((await c.getattr(r, GETATTR.ALL)).qid.type).toBe(QTDIR);
      await expect(c.walk(r, ['missing'])).rejects.toMatchObject({ errno: LINUX_ERRNO.ENOENT }); // errors still flow
      expect(observed.length).toBeGreaterThanOrEqual(3);
    } finally {
      c.close();
      await throwing.close();
    }
  });

  it('serves a second mount independently', async () => {
    const other = (await client.attach('/scratch')).fid;
    await client.lcreate(other, 'tmp.bin', O_WRONLY | O_CREAT);
    await client.write(other, 0n, Buffer.from('scratch'));
    await client.clunk(other);
    expect(readFileSync(join(dir, 'scratch', 'tmp.bin'), 'utf8')).toBe('scratch');
    expect(s3.calls).toEqual([]); // nothing reached the s3 adapter
  });
});
