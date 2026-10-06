/**
 * A 9P2000.L server over the mounts' backing directories.
 *
 * Two kinds of client speak to it. The preload shim uses it as a control plane: it keeps doing
 * the real reads and writes on the backing file itself and sends the operations that need the
 * store's say (walk, getattr, lopen, lcreate, fsync, lock, mkdir, unlinkat, renameat, clunk).
 * A kernel client (`mount -t 9p -o trans=unix`) uses the whole thing, reads and writes included.
 * Either way, fids and open-file state live here; the adapters behind the mounts stay
 * path-addressed, keyed by the virtual path, as `S3Adapter` and `LocalAdapter` already are.
 *
 * Every operation is: the adapter's hook (populate before, persist after), then the backing
 * directory does what a filesystem does, then the reply. Errors cross the wire as Linux errnos.
 */
import { Server, Socket, createServer } from 'net';
import { promises as fs, constants as fsc, type Stats, type Dirent as FsDirent } from 'fs';
import { join, posix } from 'path';
import { LINUX_ERRNO, VfsAdapter, VfsError, errnoOf } from '../server';
import {
  AT_REMOVEDIR,
  GETATTR,
  LOCK_STATUS,
  LOCK_TYPE,
  MSIZE,
  NOFID,
  NOTAG,
  QTDIR,
  QTFILE,
  QTSYMLINK,
  R,
  SETATTR,
  T,
  VERSION,
  WireError,
  decode,
  frames,
  type Attr,
  type Dirent,
  type Qid,
  type Request,
} from './wire';

export type P9Mount = {
  /** The virtual directory the application sees; also the `aname` a client attaches to. */
  mountpoint: string;
  /** The real directory that backs it. */
  backing: string;
  /** The store behind it. */
  adapter: VfsAdapter;
};

export type P9ServerOptions = {
  /** Unix-domain socket path. */
  socket: string;
  /** Called after each request is answered; `ecode` is set for an error reply. */
  onRequest?: (request: Request, mount: string | undefined, ecode?: number) => void;
};

// open(2) flags cross the wire with their Linux values; the host may number them differently.
const O_ACCMODE = 0o3;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;
const O_APPEND = 0o2000;
const O_DIRECTORY = 0o200000;

const writes = (flags: number): boolean => (flags & O_ACCMODE) !== 0 || (flags & (O_CREAT | O_TRUNC)) !== 0;

/** Linux open(2) flags as the host's fs.constants. */
const hostFlags = (flags: number): number => {
  let out = [fsc.O_RDONLY, fsc.O_WRONLY, fsc.O_RDWR, fsc.O_RDWR][flags & O_ACCMODE]!;
  if (flags & O_CREAT) out |= fsc.O_CREAT;
  if (flags & O_EXCL) out |= fsc.O_EXCL;
  if (flags & O_TRUNC) out |= fsc.O_TRUNC;
  if (flags & O_APPEND) out |= fsc.O_APPEND;
  if (flags & O_DIRECTORY) out |= fsc.O_DIRECTORY;
  return out;
};

/** A fid: a position in a mount, and what has been done through it. */
type Fid = {
  mount: P9Mount;
  /** Path relative to the mount root, '' for the root. */
  rel: string;
  flags?: number;
  /** Backing descriptor, opened lazily for a client that reads or writes through us. */
  fd?: fs.FileHandle;
  /** The adapter was told about a write through this fid; flush on fsync and clunk. */
  dirty?: boolean;
  /** This fid holds the write lock (the adapter's lease). */
  wlock?: boolean;
  /** Directory listing taken at the start of a readdir sequence. */
  dir?: Dirent[];
};

class Session {
  msize = MSIZE;
  readonly fids = new Map<number, Fid>();
}

const qidOf = (st: Stats): Qid => ({
  type: st.isDirectory() ? QTDIR : st.isSymbolicLink() ? QTSYMLINK : QTFILE,
  // The version changes whenever the content does; ctime moves with every write and attribute
  // change, which is what a cache needs to know.
  version: Math.floor(st.ctimeMs) >>> 0,
  path: BigInt(st.ino),
});

const time = (ms: number): { sec: bigint; nsec: bigint } => {
  const sec = Math.floor(ms / 1000);
  return { sec: BigInt(sec), nsec: BigInt(Math.round((ms - sec * 1000) * 1e6)) };
};

const attrOf = (st: Stats): Attr => ({
  valid: GETATTR.BASIC,
  qid: qidOf(st),
  mode: st.mode,
  uid: st.uid,
  gid: st.gid,
  nlink: BigInt(st.nlink),
  rdev: BigInt(st.rdev),
  size: BigInt(st.size),
  blksize: BigInt(st.blksize),
  blocks: BigInt(st.blocks),
  atime: time(st.atimeMs),
  mtime: time(st.mtimeMs),
  ctime: time(st.ctimeMs),
  btime: time(st.birthtimeMs),
  gen: 0n,
  dataVersion: 0n,
});

// The shim performs the real operation on the backing directory before it tells us, so the
// backing step of a structural operation may find its work already done. That is not an error.
const applied = async (op: () => Promise<unknown>, ...codes: Array<keyof typeof LINUX_ERRNO>): Promise<void> => {
  try {
    await op();
  } catch (e) {
    if (!codes.includes(((e as { code?: string }).code ?? '') as keyof typeof LINUX_ERRNO)) {
      throw e;
    }
  }
};

/** The `type` byte of a directory entry (DT_*). */
const direntType = (d: FsDirent): number =>
  d.isDirectory() ? 4 : d.isSymbolicLink() ? 10 : d.isFile() ? 8 : d.isFIFO() ? 1 : d.isSocket() ? 12 : 0;

export class P9Server {
  private server?: Server;
  private readonly _mounts: P9Mount[];
  readonly socket: string;

  constructor(
    mounts: P9Mount[],
    private readonly options: P9ServerOptions
  ) {
    const seen = new Set<string>();
    for (const { mountpoint } of mounts) {
      if (!mountpoint.startsWith('/') || mountpoint === '/' || mountpoint.endsWith('/')) {
        throw new Error(`Invalid mountpoint '${mountpoint}', expected an absolute path with no trailing slash`);
      }
      if (seen.has(mountpoint)) {
        throw new Error(`Mountpoint '${mountpoint}' is declared twice`);
      }
      seen.add(mountpoint);
    }
    this._mounts = [...mounts];
    this.socket = options.socket;
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  /** What is mounted, in declaration order. */
  get mounts(): ReadonlyArray<P9Mount> {
    return this._mounts;
  }

  async listen(): Promise<this> {
    await fs.mkdir(posix.dirname(this.socket), { recursive: true });
    await fs.rm(this.socket, { force: true });
    for (const m of this._mounts) {
      await fs.mkdir(m.backing, { recursive: true });
    }
    this.server = createServer((conn) => this.serve(conn));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socket, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    return this;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await fs.rm(this.socket, { force: true });
  }

  // ---- connection ---------------------------------------------------------------------------

  private serve(conn: Socket): void {
    const session = new Session();
    let pending = Buffer.alloc(0);
    // Requests on one connection are answered in order: the shim is synchronous and a kernel
    // client tolerates it. The queue keeps replies from interleaving while an adapter awaits.
    let chain: Promise<void> = Promise.resolve();
    conn.on('data', (chunk) => {
      let split;
      try {
        split = frames(Buffer.concat([pending, chunk]));
      } catch {
        conn.destroy();
        return;
      }
      pending = Buffer.from(split.rest);
      for (const frame of split.frames) {
        chain = chain
          .then(() => this.handle(session, frame))
          .then((reply) => {
            if (!conn.destroyed) {
              conn.write(reply);
            }
          });
      }
    });
    conn.on('close', () => {
      void chain.then(() => this.release(session));
    });
    conn.on('error', () => {});
  }

  /** Clunk everything a vanished client left behind: flushes and leases included. */
  private async release(session: Session): Promise<void> {
    for (const fid of session.fids.values()) {
      await this.clunk(fid).catch(() => {});
    }
    session.fids.clear();
  }

  private async handle(session: Session, frame: Buffer): Promise<Buffer> {
    let request: Request;
    try {
      request = decode(frame);
    } catch (e) {
      const tag = frame.length >= 7 ? frame.readUInt16LE(5) : NOTAG;
      return R.lerror(tag, e instanceof WireError ? LINUX_ERRNO.EINVAL : LINUX_ERRNO.EIO);
    }
    const mount = 'fid' in request ? session.fids.get(request.fid)?.mount.mountpoint : undefined;
    let reply: Buffer;
    let ecode: number | undefined;
    try {
      reply = await this.dispatch(session, request);
    } catch (e) {
      ecode = errnoOf(e);
      reply = R.lerror(request.tag, ecode);
    }
    // An observer that throws is the observer's problem, never the client's or the process's.
    try {
      this.options.onRequest?.(request, mount, ecode);
    } catch {
      /* ignored */
    }
    return reply;
  }

  // ---- helpers ------------------------------------------------------------------------------

  private fid(session: Session, n: number): Fid {
    const fid = session.fids.get(n);
    if (!fid) {
      throw VfsError.code('EBADF', `fid ${n} is not in use`);
    }
    return fid;
  }

  private bind(session: Session, n: number, fid: Fid): void {
    if (session.fids.has(n)) {
      throw VfsError.code('EEXIST', `fid ${n} is already in use`);
    }
    session.fids.set(n, fid);
  }

  /** The virtual path of a fid, what the adapters are addressed by. */
  private vpath(fid: Fid, rel = fid.rel): string {
    return rel ? `${fid.mount.mountpoint}/${rel}` : fid.mount.mountpoint;
  }

  private backing(fid: Fid, rel = fid.rel): string {
    return join(fid.mount.backing, rel);
  }

  /** `rel` with one name appended; `..` never climbs above the mount root. */
  private child(rel: string, name: string): string {
    if (name === '.' || name === '') {
      return rel;
    }
    if (name === '..') {
      return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    }
    if (name.includes('/') || name === '\0') {
      throw VfsError.code('EINVAL', `invalid name '${name}'`);
    }
    return rel ? `${rel}/${name}` : name;
  }

  private async lstat(fid: Fid, rel = fid.rel): Promise<Stats> {
    return fs.lstat(this.backing(fid, rel));
  }

  /** Tell the adapter about a write through this fid, once. */
  private async markDirty(fid: Fid, flags: number): Promise<void> {
    if (fid.dirty) {
      return;
    }
    await fid.mount.adapter.open(this.vpath(fid), flags);
    fid.dirty = true;
  }

  private async flush(fid: Fid): Promise<void> {
    if (!fid.dirty) {
      return;
    }
    await fid.mount.adapter.flush(this.vpath(fid));
  }

  private async clunk(fid: Fid): Promise<void> {
    try {
      if (fid.fd) {
        await fid.fd.close().catch(() => {});
        fid.fd = undefined;
      }
      if (fid.wlock) {
        fid.wlock = false;
        await this.flush(fid);
        await fid.mount.adapter.unlock?.(this.vpath(fid));
      } else {
        await this.flush(fid);
      }
    } finally {
      fid.dirty = false;
    }
  }

  // ---- dispatch -----------------------------------------------------------------------------

  private async dispatch(session: Session, req: Request): Promise<Buffer> {
    switch (req.type) {
      case T.Tversion: {
        session.msize = Math.min(req.msize, MSIZE);
        session.fids.clear();
        return R.version(req.tag, session.msize, req.version === VERSION ? VERSION : 'unknown');
      }

      case T.Tattach: {
        const mount = this._mounts.find((m) => m.mountpoint === req.aname);
        if (!mount) {
          throw VfsError.code('ENOENT', `no mount at '${req.aname}'`);
        }
        const fid: Fid = { mount, rel: '' };
        await mount.adapter.stat(mount.mountpoint);
        const st = await this.lstat(fid);
        this.bind(session, req.fid, fid);
        return R.attach(req.tag, qidOf(st));
      }

      case T.Tauth:
        throw VfsError.code('ENOTSUP', 'no authentication');

      case T.Tflush:
        return R.flush(req.tag); // every request is answered promptly; nothing to cancel

      case T.Twalk: {
        const from = this.fid(session, req.fid);
        if (req.newfid !== req.fid && session.fids.has(req.newfid)) {
          throw VfsError.code('EEXIST', `fid ${req.newfid} is already in use`);
        }
        if (from.fd || from.flags !== undefined) {
          throw VfsError.code('EINVAL', 'cannot walk from an open fid');
        }
        let rel = from.rel;
        const qids: Qid[] = [];
        for (const name of req.names) {
          const next = this.child(rel, name);
          try {
            await from.mount.adapter.stat(this.vpath(from, next));
            const st = await this.lstat(from, next);
            if (qids.length < req.names.length - 1 && !st.isDirectory()) {
              throw VfsError.code('ENOTDIR', `${this.vpath(from, next)} is not a directory`);
            }
            qids.push(qidOf(st));
            rel = next;
          } catch (e) {
            if (qids.length === 0) {
              throw e; // the first name must resolve; later misses are a partial walk
            }
            break;
          }
        }
        if (qids.length === req.names.length) {
          const fid: Fid = { mount: from.mount, rel };
          if (req.newfid === req.fid) {
            session.fids.set(req.fid, fid);
          } else {
            this.bind(session, req.newfid, fid);
          }
        }
        return R.walk(req.tag, qids);
      }

      case T.Tclunk: {
        const fid = this.fid(session, req.fid);
        session.fids.delete(req.fid);
        await this.clunk(fid);
        return R.clunk(req.tag);
      }

      case T.Tremove: {
        const fid = this.fid(session, req.fid);
        session.fids.delete(req.fid);
        await this.clunk(fid);
        const st = await this.lstat(fid);
        if (st.isDirectory()) {
          await fs.rmdir(this.backing(fid));
        } else {
          await fs.unlink(this.backing(fid));
        }
        await fid.mount.adapter.unlink(this.vpath(fid));
        return R.remove(req.tag);
      }

      case T.Tstatfs: {
        const fid = this.fid(session, req.fid);
        const s = await fs.statfs(this.backing(fid));
        return R.statfs(req.tag, {
          type: 0x01021997, // V9FS_MAGIC
          bsize: s.bsize,
          blocks: BigInt(s.blocks),
          bfree: BigInt(s.bfree),
          bavail: BigInt(s.bavail),
          files: BigInt(s.files),
          ffree: BigInt(s.ffree),
          fsid: 0n,
          namelen: 255,
        });
      }

      case T.Tgetattr: {
        const fid = this.fid(session, req.fid);
        // The hook behind every stat: metadata present, local copy re-checked against the store.
        await fid.mount.adapter.stat(this.vpath(fid));
        const st = await this.lstat(fid);
        return R.getattr(req.tag, attrOf(st));
      }

      case T.Tlopen: {
        const fid = this.fid(session, req.fid);
        if (fid.flags !== undefined) {
          throw VfsError.code('EINVAL', 'fid is already open');
        }
        const vpath = this.vpath(fid);
        let st = await this.lstat(fid);
        if (st.isDirectory()) {
          fid.dir = await this.entries(fid); // entries present before the client lists them
        } else {
          if (!(req.flags & O_TRUNC)) {
            await fid.mount.adapter.fetch(vpath); // contents present before the first read
          }
          if (writes(req.flags)) {
            await this.markDirty(fid, req.flags);
            if (req.flags & O_TRUNC) {
              await fs.truncate(this.backing(fid), 0);
            }
          }
          st = await this.lstat(fid);
        }
        fid.flags = req.flags;
        return R.lopen(req.tag, qidOf(st), 0);
      }

      case T.Tlcreate: {
        const dir = this.fid(session, req.fid);
        const rel = this.child(dir.rel, req.name);
        const flags = req.flags | O_CREAT;
        const vpath = this.vpath(dir, rel);
        const path = this.backing(dir, rel);
        // The store may already have this object: make it present first unless we are truncating,
        // so an O_EXCL create fails on it and a plain open does not clobber it.
        if (!(flags & O_TRUNC)) {
          await dir.mount.adapter.fetch(vpath).catch((e) => {
            if (errnoOf(e) !== LINUX_ERRNO.ENOENT) {
              throw e;
            }
          });
        }
        const handle = await fs.open(path, hostFlags(flags), req.mode);
        await handle.close();
        // The fid now refers to the new file, as the protocol says.
        dir.rel = rel;
        dir.flags = flags;
        await this.markDirty(dir, flags);
        const st = await this.lstat(dir);
        return R.lcreate(req.tag, qidOf(st), 0);
      }

      case T.Tsymlink: {
        const dir = this.fid(session, req.fid);
        const rel = this.child(dir.rel, req.name);
        await applied(() => fs.symlink(req.target, this.backing(dir, rel)), 'EEXIST');
        await dir.mount.adapter.flush(this.vpath(dir, rel));
        return R.symlink(req.tag, qidOf(await this.lstat(dir, rel)));
      }

      case T.Tmknod:
      case T.Txattrwalk:
      case T.Txattrcreate:
        throw VfsError.code('ENOTSUP', 'not supported');

      case T.Trename: {
        const fid = this.fid(session, req.fid);
        const dir = this.fid(session, req.dfid);
        return this.rename(req.tag, fid, fid.rel, dir, this.child(dir.rel, req.name), (rel) => (fid.rel = rel));
      }

      case T.Trenameat: {
        const from = this.fid(session, req.olddirfid);
        const to = this.fid(session, req.newdirfid);
        return this.rename(req.tag, from, this.child(from.rel, req.oldname), to, this.child(to.rel, req.newname));
      }

      case T.Treadlink: {
        const fid = this.fid(session, req.fid);
        return R.readlink(req.tag, await fs.readlink(this.backing(fid)));
      }

      case T.Tsetattr: {
        const fid = this.fid(session, req.fid);
        const path = this.backing(fid);
        if (req.valid & SETATTR.SIZE) {
          await this.markDirty(fid, O_WRONLY);
          await fs.truncate(path, Number(req.size));
        }
        if (req.valid & SETATTR.MODE) {
          await fs.chmod(path, req.mode & 0o7777);
        }
        if (req.valid & (SETATTR.UID | SETATTR.GID)) {
          const st = await this.lstat(fid);
          await fs
            .chown(path, req.valid & SETATTR.UID ? req.uid : st.uid, req.valid & SETATTR.GID ? req.gid : st.gid)
            .catch(() => {});
        }
        if (req.valid & (SETATTR.ATIME | SETATTR.MTIME)) {
          const st = await this.lstat(fid);
          const now = Date.now();
          const pick = (set: number, explicit: number, t: { sec: bigint; nsec: bigint }, current: number): number =>
            req.valid & set ? (req.valid & explicit ? Number(t.sec) * 1000 + Number(t.nsec) / 1e6 : now) : current;
          await fs.utimes(
            path,
            pick(SETATTR.ATIME, SETATTR.ATIME_SET, req.atime, st.atimeMs) / 1000,
            pick(SETATTR.MTIME, SETATTR.MTIME_SET, req.mtime, st.mtimeMs) / 1000
          );
        }
        if (req.valid & SETATTR.SIZE) {
          await this.flush(fid); // a truncate through setattr is complete in itself
          fid.dirty = false;
        }
        return R.setattr(req.tag);
      }

      case T.Treaddir: {
        const fid = this.fid(session, req.fid);
        if (!fid.dir || req.offset === 0n) {
          fid.dir = await this.entries(fid, !!fid.dir); // a rewind re-reads the directory, not the store
        }
        const rest = fid.dir.filter((e) => e.offset > req.offset);
        return R.readdir(req.tag, rest, Math.min(req.count, session.msize - 11));
      }

      case T.Tfsync: {
        const fid = this.fid(session, req.fid);
        await fid.fd?.sync().catch(() => {});
        await this.flush(fid);
        return R.fsync(req.tag);
      }

      case T.Tlock: {
        const fid = this.fid(session, req.fid);
        const vpath = this.vpath(fid);
        const { adapter } = fid.mount;
        // The lock ladder, by type only, as the shim forwards it: a read lock re-checks the local
        // copy, the first write lock takes the lease, the unlock after a write lock persists and
        // gives it back. A contended lease is BLOCKED, which a client reports as EAGAIN.
        try {
          if (req.lock.type === LOCK_TYPE.WRLCK) {
            if (!fid.wlock) {
              await adapter.lock?.(vpath);
              fid.wlock = true;
              fid.dirty = fid.dirty || !!adapter.lock; // a write will follow; the unlock flushes it
            }
          } else if (req.lock.type === LOCK_TYPE.RDLCK) {
            if (!fid.wlock) {
              await adapter.revalidate?.(vpath);
            }
          } else if (fid.wlock) {
            fid.wlock = false;
            await this.flush(fid);
            fid.dirty = false;
            await adapter.unlock?.(vpath);
          }
        } catch (e) {
          if (errnoOf(e) === LINUX_ERRNO.EAGAIN) {
            return R.lock(req.tag, LOCK_STATUS.BLOCKED);
          }
          throw e;
        }
        return R.lock(req.tag, LOCK_STATUS.SUCCESS);
      }

      case T.Tgetlock: {
        this.fid(session, req.fid);
        return R.getlock(req.tag, { ...req.lock, type: LOCK_TYPE.UNLCK }); // no conflicting lock is known here
      }

      case T.Tlink: {
        const dir = this.fid(session, req.dfid);
        const target = this.fid(session, req.fid);
        if (dir.mount !== target.mount) {
          throw VfsError.code('EXDEV', 'link across mounts');
        }
        const rel = this.child(dir.rel, req.name);
        await applied(() => fs.link(this.backing(target), this.backing(dir, rel)), 'EEXIST');
        await dir.mount.adapter.flush(this.vpath(dir, rel));
        return R.link(req.tag);
      }

      case T.Tmkdir: {
        const dir = this.fid(session, req.dfid);
        const rel = this.child(dir.rel, req.name);
        await applied(async () => {
          try {
            await fs.mkdir(this.backing(dir, rel), req.mode & 0o7777);
          } catch (e) {
            if ((e as { code?: string }).code !== 'EEXIST' || !(await this.lstat(dir, rel)).isDirectory()) {
              throw e;
            }
          }
        });
        await dir.mount.adapter.mkdir(this.vpath(dir, rel));
        return R.mkdir(req.tag, qidOf(await this.lstat(dir, rel)));
      }

      case T.Tunlinkat: {
        const dir = this.fid(session, req.dirfid);
        const rel = this.child(dir.rel, req.name);
        const path = this.backing(dir, rel);
        // The shim does not say whether it removed a file or a directory; either is gone by now.
        await applied(async () => {
          try {
            await (req.flags & AT_REMOVEDIR ? fs.rmdir(path) : fs.unlink(path));
          } catch (e) {
            const code = (e as { code?: string }).code;
            if (code === 'EISDIR' || code === 'EPERM') {
              await fs.rmdir(path);
            } else {
              throw e;
            }
          }
        }, 'ENOENT');
        await dir.mount.adapter.unlink(this.vpath(dir, rel));
        return R.unlinkat(req.tag);
      }

      case T.Tread: {
        const fid = this.fid(session, req.fid);
        const fd = await this.descriptor(fid);
        const buf = Buffer.alloc(Math.min(req.count, session.msize - 11));
        const { bytesRead } = await fd.read(buf, 0, buf.length, Number(req.offset));
        return R.read(req.tag, buf.subarray(0, bytesRead));
      }

      case T.Twrite: {
        const fid = this.fid(session, req.fid);
        const fd = await this.descriptor(fid);
        await this.markDirty(fid, fid.flags ?? O_RDWR);
        const { bytesWritten } = await fd.write(req.data, 0, req.data.length, Number(req.offset));
        return R.write(req.tag, bytesWritten);
      }
    }
    throw VfsError.code('ENOTSUP', 'unknown request');
  }

  /** The directory's entries, `.` and `..` first, after the list hook has made them present. */
  private async entries(fid: Fid, listed = false): Promise<Dirent[]> {
    if (!listed) {
      await fid.mount.adapter.list(this.vpath(fid));
    }
    const names = await fs.readdir(this.backing(fid), { withFileTypes: true });
    const self = qidOf(await this.lstat(fid));
    const parent = qidOf(await this.lstat(fid, this.child(fid.rel, '..')));
    const entries: Dirent[] = [
      { qid: self, offset: 1n, type: 4, name: '.' },
      { qid: parent, offset: 2n, type: 4, name: '..' },
    ];
    for (const d of names) {
      const st = await fs.lstat(join(this.backing(fid), d.name)).catch(() => undefined);
      if (st) {
        entries.push({ qid: qidOf(st), offset: BigInt(entries.length + 1), type: direntType(d), name: d.name });
      }
    }
    return entries;
  }

  /** The backing descriptor for a fid a client reads or writes through, opened on first use. */
  private async descriptor(fid: Fid): Promise<fs.FileHandle> {
    if (fid.flags === undefined) {
      throw VfsError.code('EBADF', 'fid is not open');
    }
    if (!fid.fd) {
      fid.fd = await fs.open(this.backing(fid), (fid.flags & O_ACCMODE) === 0 ? fsc.O_RDONLY : fsc.O_RDWR);
    }
    return fid.fd;
  }

  private async rename(
    tag: number,
    from: Fid,
    fromRel: string,
    to: Fid,
    toRel: string,
    moved?: (rel: string) => void
  ): Promise<Buffer> {
    if (from.mount !== to.mount) {
      throw VfsError.code('EXDEV', 'rename across mounts');
    }
    try {
      await fs.rename(this.backing(from, fromRel), this.backing(to, toRel));
    } catch (e) {
      // Already moved by the shim: the source is gone and the target is there.
      const target = await fs.lstat(this.backing(to, toRel)).catch(() => undefined);
      if ((e as { code?: string }).code !== 'ENOENT' || !target) {
        throw e;
      }
    }
    await from.mount.adapter.rename(this.vpath(from, fromRel), this.vpath(to, toRel));
    moved?.(toRel);
    return R.rename(tag);
  }
}

export { NOFID };
