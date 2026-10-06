/**
 * A small 9P2000.L client over a unix socket: one request in flight at a time, replies matched by
 * tag. Enough for the tests, for a conformance check against the server, and for tooling.
 */
import { Socket, connect } from 'net';
import { LINUX_ERRNO, VfsError } from '../server';
import {
  GETATTR,
  MSIZE,
  NOFID,
  NOTAG,
  R,
  T,
  Treq,
  VERSION,
  decodeReply,
  frames,
  type Attr,
  type Dirent,
  type Lock,
  type Qid,
  type Reply,
  type SetAttr,
  type Statfs,
} from './wire';

export class P9Client {
  private conn?: Socket;
  private pending = Buffer.alloc(0);
  private waiting?: { tag: number; resolve: (r: Reply) => void; reject: (e: Error) => void };
  private tag = 0;
  private nextFid = 1;
  msize = MSIZE;

  constructor(readonly socket: string) {}

  async connect(): Promise<this> {
    this.conn = await new Promise<Socket>((resolve, reject) => {
      const c = connect(this.socket);
      c.once('connect', () => resolve(c));
      c.once('error', reject);
    });
    this.conn.on('data', (chunk) => {
      const split = frames(Buffer.concat([this.pending, chunk]));
      this.pending = Buffer.from(split.rest);
      for (const frame of split.frames) {
        const reply = decodeReply(frame);
        if (this.waiting && this.waiting.tag === reply.tag) {
          const w = this.waiting;
          this.waiting = undefined;
          w.resolve(reply);
        }
      }
    });
    this.conn.on('error', (e) => this.waiting?.reject(e));
    this.conn.on('close', () => this.waiting?.reject(new Error('connection closed')));
    return this;
  }

  close(): void {
    this.conn?.destroy();
    this.conn = undefined;
  }

  /** A fid number not in use by this client. */
  fid(): number {
    return this.nextFid++;
  }

  private async call(frame: Buffer, tag: number): Promise<Reply> {
    if (!this.conn) {
      throw new Error('not connected');
    }
    if (this.waiting) {
      throw new Error('a request is already in flight');
    }
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.waiting = { tag, resolve, reject };
      this.conn!.write(frame);
    });
    if (reply.type === T.Rlerror) {
      const ecode = (reply as { ecode: number }).ecode;
      const code = (Object.keys(LINUX_ERRNO) as Array<keyof typeof LINUX_ERRNO>).find((k) => LINUX_ERRNO[k] === ecode);
      throw code ? VfsError.code(code, `9P error ${ecode}`) : new VfsError(ecode, `9P error ${ecode}`);
    }
    return reply;
  }

  private next(): number {
    this.tag = (this.tag + 1) & 0xfffe;
    return this.tag;
  }

  async version(msize = MSIZE): Promise<{ msize: number; version: string }> {
    const r = (await this.call(Treq.version(NOTAG, msize, VERSION), NOTAG)) as { msize: number; version: string };
    this.msize = r.msize;
    return { msize: r.msize, version: r.version };
  }

  async attach(aname: string, fid = this.fid()): Promise<{ fid: number; qid: Qid }> {
    const r = (await this.call(Treq.attach(this.next(), fid, NOFID, 'rowdy', aname, 0), this.tag)) as { qid: Qid };
    return { fid, qid: r.qid };
  }

  async walk(fid: number, names: string[], newfid = this.fid()): Promise<{ fid: number; qids: Qid[] }> {
    const r = (await this.call(Treq.walk(this.next(), fid, newfid, names), this.tag)) as { qids: Qid[] };
    return { fid: newfid, qids: r.qids };
  }

  async clunk(fid: number): Promise<void> {
    await this.call(Treq.clunk(this.next(), fid), this.tag);
  }

  async remove(fid: number): Promise<void> {
    await this.call(Treq.remove(this.next(), fid), this.tag);
  }

  async statfs(fid: number): Promise<Statfs> {
    return ((await this.call(Treq.statfs(this.next(), fid), this.tag)) as { statfs: Statfs }).statfs;
  }

  async getattr(fid: number, mask: bigint = GETATTR.BASIC): Promise<Attr> {
    return (await this.call(Treq.getattr(this.next(), fid, mask), this.tag)) as unknown as Attr;
  }

  async setattr(fid: number, attr: Partial<SetAttr> & { valid: number }): Promise<void> {
    await this.call(Treq.setattr(this.next(), fid, attr), this.tag);
  }

  async lopen(fid: number, flags: number): Promise<{ qid: Qid; iounit: number }> {
    return (await this.call(Treq.lopen(this.next(), fid, flags), this.tag)) as { qid: Qid; iounit: number };
  }

  async lcreate(
    fid: number,
    name: string,
    flags: number,
    mode = 0o644,
    gid = 0
  ): Promise<{ qid: Qid; iounit: number }> {
    return (await this.call(Treq.lcreate(this.next(), fid, name, flags, mode, gid), this.tag)) as {
      qid: Qid;
      iounit: number;
    };
  }

  async symlink(dfid: number, name: string, target: string, gid = 0): Promise<Qid> {
    return ((await this.call(Treq.symlink(this.next(), dfid, name, target, gid), this.tag)) as { qid: Qid }).qid;
  }

  async readlink(fid: number): Promise<string> {
    return ((await this.call(Treq.readlink(this.next(), fid), this.tag)) as { target: string }).target;
  }

  async readdir(fid: number, offset = 0n, count = 8192): Promise<Dirent[]> {
    return ((await this.call(Treq.readdir(this.next(), fid, offset, count), this.tag)) as { entries: Dirent[] })
      .entries;
  }

  /** Every entry, following the offsets until the server has no more. */
  async readdirAll(fid: number): Promise<Dirent[]> {
    const all: Dirent[] = [];
    let offset = 0n;
    for (;;) {
      const page = await this.readdir(fid, offset);
      if (!page.length) {
        return all;
      }
      all.push(...page);
      offset = page[page.length - 1]!.offset;
    }
  }

  async fsync(fid: number): Promise<void> {
    await this.call(Treq.fsync(this.next(), fid), this.tag);
  }

  async lock(fid: number, type: number, clientId = 'rowdy'): Promise<number> {
    const lock: Lock = { type, flags: 0, start: 0n, length: 0n, procId: process.pid, clientId };
    return ((await this.call(Treq.lock(this.next(), fid, lock), this.tag)) as { status: number }).status;
  }

  async getlock(fid: number, type: number): Promise<Omit<Lock, 'flags'>> {
    const lock: Lock = { type, flags: 0, start: 0n, length: 0n, procId: process.pid, clientId: 'rowdy' };
    return ((await this.call(Treq.getlock(this.next(), fid, lock), this.tag)) as { lock: Omit<Lock, 'flags'> }).lock;
  }

  async link(dfid: number, fid: number, name: string): Promise<void> {
    await this.call(Treq.link(this.next(), dfid, fid, name), this.tag);
  }

  async mkdir(dfid: number, name: string, mode = 0o755, gid = 0): Promise<Qid> {
    return ((await this.call(Treq.mkdir(this.next(), dfid, name, mode, gid), this.tag)) as { qid: Qid }).qid;
  }

  async renameat(olddirfid: number, oldname: string, newdirfid: number, newname: string): Promise<void> {
    await this.call(Treq.renameat(this.next(), olddirfid, oldname, newdirfid, newname), this.tag);
  }

  async unlinkat(dirfid: number, name: string, flags = 0): Promise<void> {
    await this.call(Treq.unlinkat(this.next(), dirfid, name, flags), this.tag);
  }

  async read(fid: number, offset: bigint, count: number): Promise<Buffer> {
    return ((await this.call(Treq.read(this.next(), fid, offset, count), this.tag)) as { data: Buffer }).data;
  }

  async write(fid: number, offset: bigint, data: Buffer): Promise<number> {
    return ((await this.call(Treq.write(this.next(), fid, offset, data), this.tag)) as { count: number }).count;
  }

  /** Convenience: walk from `root` to `path`, run `fn`, clunk. */
  async withFid<U>(root: number, path: string, fn: (fid: number) => Promise<U>): Promise<U> {
    const names = path.split('/').filter(Boolean);
    const { fid, qids } = await this.walk(root, names);
    if (qids.length !== names.length) {
      throw VfsError.code('ENOENT', `${path}: walk stopped after ${qids.length} of ${names.length}`);
    }
    try {
      return await fn(fid);
    } finally {
      await this.clunk(fid).catch(() => {});
    }
  }
}

export { R };
