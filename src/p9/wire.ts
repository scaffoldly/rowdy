/**
 * 9P2000.L on the wire: framing and the field layouts the server and the shim exchange.
 *
 * Every message is `size[4] type[1] tag[2]` followed by type-specific fields, all little-endian.
 * `s` is a string: `len[2]` then that many bytes of UTF-8. A qid is `type[1] version[4] path[8]`.
 * Layouts follow the 9P2000.L specification (https://github.com/chaos/diod/blob/master/protocol.md)
 * and the 9P2000 base it extends.
 */

export const VERSION = '9P2000.L';
export const NOTAG = 0xffff;
export const NOFID = 0xffffffff;
/** Largest message either side sends before negotiation; room for a 1 MiB read. */
export const MSIZE = 1024 * 1024 + 24;

/** Request types. A reply is the request type + 1; Rlerror is the one reply without a request. */
export const T = {
  Rlerror: 7,
  Tstatfs: 8,
  Tlopen: 12,
  Tlcreate: 14,
  Tsymlink: 16,
  Tmknod: 18,
  Trename: 20,
  Treadlink: 22,
  Tgetattr: 24,
  Tsetattr: 26,
  Txattrwalk: 30,
  Txattrcreate: 32,
  Treaddir: 40,
  Tfsync: 50,
  Tlock: 52,
  Tgetlock: 54,
  Tlink: 70,
  Tmkdir: 72,
  Trenameat: 74,
  Tunlinkat: 76,
  Tversion: 100,
  Tauth: 102,
  Tattach: 104,
  Tflush: 108,
  Twalk: 110,
  Tread: 116,
  Twrite: 118,
  Tclunk: 120,
  Tremove: 122,
} as const;

export type TType = (typeof T)[keyof typeof T];

/** qid.type bits. */
export const QTDIR = 0x80;
export const QTSYMLINK = 0x02;
export const QTFILE = 0x00;

export const LOCK_TYPE = { RDLCK: 0, WRLCK: 1, UNLCK: 2 } as const;
export const LOCK_STATUS = { SUCCESS: 0, BLOCKED: 1, ERROR: 2, GRACE: 3 } as const;
export const LOCK_FLAGS = { BLOCK: 1, RECLAIM: 2 } as const;

/** Tgetattr request_mask / Rgetattr valid bits. */
export const GETATTR = {
  MODE: 0x1n,
  NLINK: 0x2n,
  UID: 0x4n,
  GID: 0x8n,
  RDEV: 0x10n,
  ATIME: 0x20n,
  MTIME: 0x40n,
  CTIME: 0x80n,
  INO: 0x100n,
  SIZE: 0x200n,
  BLOCKS: 0x400n,
  BTIME: 0x800n,
  GEN: 0x1000n,
  DATA_VERSION: 0x2000n,
  BASIC: 0x7ffn,
  ALL: 0x3fffn,
} as const;

/** Tsetattr valid bits. */
export const SETATTR = {
  MODE: 0x1,
  UID: 0x2,
  GID: 0x4,
  SIZE: 0x8,
  ATIME: 0x10,
  MTIME: 0x20,
  CTIME: 0x40,
  ATIME_SET: 0x80,
  MTIME_SET: 0x100,
} as const;

/** Tunlinkat flags. */
export const AT_REMOVEDIR = 0x200;

export type Qid = { type: number; version: number; path: bigint };
export type Time = { sec: bigint; nsec: bigint };

export type Attr = {
  valid: bigint;
  qid: Qid;
  mode: number;
  uid: number;
  gid: number;
  nlink: bigint;
  rdev: bigint;
  size: bigint;
  blksize: bigint;
  blocks: bigint;
  atime: Time;
  mtime: Time;
  ctime: Time;
  btime: Time;
  gen: bigint;
  dataVersion: bigint;
};

export type Dirent = { qid: Qid; offset: bigint; type: number; name: string };

export type Statfs = {
  type: number;
  bsize: number;
  blocks: bigint;
  bfree: bigint;
  bavail: bigint;
  files: bigint;
  ffree: bigint;
  fsid: bigint;
  namelen: number;
};

export type Lock = {
  type: number;
  flags: number;
  start: bigint;
  length: bigint;
  procId: number;
  clientId: string;
};

export type SetAttr = {
  valid: number;
  mode: number;
  uid: number;
  gid: number;
  size: bigint;
  atime: Time;
  mtime: Time;
};

/** A decoded request. `tag` is echoed in the reply. */
export type Request = { tag: number } & (
  | { type: typeof T.Tversion; msize: number; version: string }
  | { type: typeof T.Tauth; afid: number; uname: string; aname: string; nUname: number }
  | { type: typeof T.Tattach; fid: number; afid: number; uname: string; aname: string; nUname: number }
  | { type: typeof T.Tflush; oldtag: number }
  | { type: typeof T.Twalk; fid: number; newfid: number; names: string[] }
  | { type: typeof T.Tclunk; fid: number }
  | { type: typeof T.Tremove; fid: number }
  | { type: typeof T.Tstatfs; fid: number }
  | { type: typeof T.Tlopen; fid: number; flags: number }
  | { type: typeof T.Tlcreate; fid: number; name: string; flags: number; mode: number; gid: number }
  | { type: typeof T.Tsymlink; fid: number; name: string; target: string; gid: number }
  | { type: typeof T.Tmknod; fid: number; name: string; mode: number; major: number; minor: number; gid: number }
  | { type: typeof T.Trename; fid: number; dfid: number; name: string }
  | { type: typeof T.Treadlink; fid: number }
  | { type: typeof T.Tgetattr; fid: number; mask: bigint }
  | ({ type: typeof T.Tsetattr; fid: number } & SetAttr)
  | { type: typeof T.Txattrwalk; fid: number; newfid: number; name: string }
  | { type: typeof T.Txattrcreate; fid: number; name: string; size: bigint; flags: number }
  | { type: typeof T.Treaddir; fid: number; offset: bigint; count: number }
  | { type: typeof T.Tfsync; fid: number }
  | { type: typeof T.Tlock; fid: number; lock: Lock }
  | { type: typeof T.Tgetlock; fid: number; lock: Lock }
  | { type: typeof T.Tlink; dfid: number; fid: number; name: string }
  | { type: typeof T.Tmkdir; dfid: number; name: string; mode: number; gid: number }
  | { type: typeof T.Trenameat; olddirfid: number; oldname: string; newdirfid: number; newname: string }
  | { type: typeof T.Tunlinkat; dirfid: number; name: string; flags: number }
  | { type: typeof T.Tread; fid: number; offset: bigint; count: number }
  | { type: typeof T.Twrite; fid: number; offset: bigint; data: Buffer }
);

/** A frame that is not well-formed 9P2000.L. */
export class WireError extends Error {}

// ---- reading ----------------------------------------------------------------

class Reader {
  private off = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.off;
  }

  private need(n: number): void {
    if (this.off + n > this.buf.length) {
      throw new WireError(`message truncated: need ${n} bytes at offset ${this.off} of ${this.buf.length}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.off++]!;
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }
  s(): string {
    const len = this.u16();
    this.need(len);
    const v = this.buf.toString('utf8', this.off, this.off + len);
    this.off += len;
    return v;
  }
  bytes(n: number): Buffer {
    this.need(n);
    const v = Buffer.from(this.buf.subarray(this.off, this.off + n));
    this.off += n;
    return v;
  }
  qid(): Qid {
    return { type: this.u8(), version: this.u32(), path: this.u64() };
  }
  time(): Time {
    return { sec: this.u64(), nsec: this.u64() };
  }
  lock(): Lock {
    return {
      type: this.u8(),
      flags: this.u32(),
      start: this.u64(),
      length: this.u64(),
      procId: this.u32(),
      clientId: this.s(),
    };
  }
}

/** Splits a stream buffer into complete frames and the unconsumed remainder. */
export const frames = (buf: Buffer): { frames: Buffer[]; rest: Buffer } => {
  const out: Buffer[] = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const size = buf.readUInt32LE(off);
    if (size < 7) {
      throw new WireError(`frame size ${size} is below the 7-byte header`);
    }
    if (buf.length - off < size) {
      break;
    }
    out.push(buf.subarray(off, off + size));
    off += size;
  }
  return { frames: out, rest: buf.subarray(off) };
};

/** Decodes one complete frame into a request. */
export const decode = (frame: Buffer): Request => {
  const r = new Reader(frame);
  const size = r.u32();
  if (size !== frame.length) {
    throw new WireError(`frame size ${size} does not match ${frame.length} bytes`);
  }
  const type = r.u8();
  const tag = r.u16();
  switch (type) {
    case T.Tversion:
      return { tag, type, msize: r.u32(), version: r.s() };
    case T.Tauth:
      return { tag, type, afid: r.u32(), uname: r.s(), aname: r.s(), nUname: r.u32() };
    case T.Tattach:
      return { tag, type, fid: r.u32(), afid: r.u32(), uname: r.s(), aname: r.s(), nUname: r.u32() };
    case T.Tflush:
      return { tag, type, oldtag: r.u16() };
    case T.Twalk: {
      const fid = r.u32();
      const newfid = r.u32();
      const n = r.u16();
      const names: string[] = [];
      for (let i = 0; i < n; i++) {
        names.push(r.s());
      }
      return { tag, type, fid, newfid, names };
    }
    case T.Tclunk:
    case T.Tremove:
    case T.Tstatfs:
    case T.Treadlink:
    case T.Tfsync:
      return { tag, type, fid: r.u32() };
    case T.Tlopen:
      return { tag, type, fid: r.u32(), flags: r.u32() };
    case T.Tlcreate:
      return { tag, type, fid: r.u32(), name: r.s(), flags: r.u32(), mode: r.u32(), gid: r.u32() };
    case T.Tsymlink:
      return { tag, type, fid: r.u32(), name: r.s(), target: r.s(), gid: r.u32() };
    case T.Tmknod:
      return { tag, type, fid: r.u32(), name: r.s(), mode: r.u32(), major: r.u32(), minor: r.u32(), gid: r.u32() };
    case T.Trename:
      return { tag, type, fid: r.u32(), dfid: r.u32(), name: r.s() };
    case T.Tgetattr:
      return { tag, type, fid: r.u32(), mask: r.u64() };
    case T.Tsetattr:
      return {
        tag,
        type,
        fid: r.u32(),
        valid: r.u32(),
        mode: r.u32(),
        uid: r.u32(),
        gid: r.u32(),
        size: r.u64(),
        atime: r.time(),
        mtime: r.time(),
      };
    case T.Txattrwalk:
      return { tag, type, fid: r.u32(), newfid: r.u32(), name: r.s() };
    case T.Txattrcreate:
      return { tag, type, fid: r.u32(), name: r.s(), size: r.u64(), flags: r.u32() };
    case T.Treaddir:
      return { tag, type, fid: r.u32(), offset: r.u64(), count: r.u32() };
    case T.Tlock:
    case T.Tgetlock:
      return { tag, type, fid: r.u32(), lock: r.lock() };
    case T.Tlink:
      return { tag, type, dfid: r.u32(), fid: r.u32(), name: r.s() };
    case T.Tmkdir:
      return { tag, type, dfid: r.u32(), name: r.s(), mode: r.u32(), gid: r.u32() };
    case T.Trenameat:
      return { tag, type, olddirfid: r.u32(), oldname: r.s(), newdirfid: r.u32(), newname: r.s() };
    case T.Tunlinkat:
      return { tag, type, dirfid: r.u32(), name: r.s(), flags: r.u32() };
    case T.Tread:
      return { tag, type, fid: r.u32(), offset: r.u64(), count: r.u32() };
    case T.Twrite: {
      const fid = r.u32();
      const offset = r.u64();
      const count = r.u32();
      return { tag, type, fid, offset, data: r.bytes(count) };
    }
    default:
      throw new WireError(`unknown message type ${type}`);
  }
};

// ---- writing ----------------------------------------------------------------

class Writer {
  private parts: Buffer[] = [];
  private length = 0;

  private push(b: Buffer): void {
    this.parts.push(b);
    this.length += b.length;
  }
  u8(v: number): this {
    this.push(Buffer.from([v & 0xff]));
    return this;
  }
  u16(v: number): this {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    this.push(b);
    return this;
  }
  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    this.push(b);
    return this;
  }
  u64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt.asUintN(64, v));
    this.push(b);
    return this;
  }
  s(v: string): this {
    const b = Buffer.from(v, 'utf8');
    if (b.length > 0xffff) {
      throw new WireError(`string of ${b.length} bytes exceeds the 16-bit length`);
    }
    this.u16(b.length);
    this.push(b);
    return this;
  }
  bytes(b: Buffer): this {
    this.push(b);
    return this;
  }
  qid(q: Qid): this {
    return this.u8(q.type).u32(q.version).u64(q.path);
  }
  time(t: Time): this {
    return this.u64(t.sec).u64(t.nsec);
  }
  lock(l: Lock): this {
    return this.u8(l.type).u32(l.flags).u64(l.start).u64(l.length).u32(l.procId).s(l.clientId);
  }

  /** The body written so far, without a header. */
  body(): Buffer {
    return Buffer.concat(this.parts);
  }

  /** The frame: `size[4] type[1] tag[2]` then everything written. */
  frame(type: number, tag: number): Buffer {
    const header = Buffer.alloc(7);
    header.writeUInt32LE(7 + this.length);
    header[4] = type;
    header.writeUInt16LE(tag, 5);
    return Buffer.concat([header, ...this.parts]);
  }
}

const reply = (type: TType, tag: number, fill: (w: Writer) => void = () => {}): Buffer => {
  const w = new Writer();
  fill(w);
  return w.frame(type + 1, tag);
};

/** Reply encoders, one per request type, plus the error reply. */
export const R = {
  lerror: (tag: number, ecode: number): Buffer => new Writer().u32(ecode).frame(T.Rlerror, tag),
  version: (tag: number, msize: number, version: string): Buffer =>
    reply(T.Tversion, tag, (w) => w.u32(msize).s(version)),
  attach: (tag: number, qid: Qid): Buffer => reply(T.Tattach, tag, (w) => w.qid(qid)),
  flush: (tag: number): Buffer => reply(T.Tflush, tag),
  walk: (tag: number, qids: Qid[]): Buffer =>
    reply(T.Twalk, tag, (w) => {
      w.u16(qids.length);
      qids.forEach((q) => w.qid(q));
    }),
  clunk: (tag: number): Buffer => reply(T.Tclunk, tag),
  remove: (tag: number): Buffer => reply(T.Tremove, tag),
  statfs: (tag: number, s: Statfs): Buffer =>
    reply(T.Tstatfs, tag, (w) =>
      w
        .u32(s.type)
        .u32(s.bsize)
        .u64(s.blocks)
        .u64(s.bfree)
        .u64(s.bavail)
        .u64(s.files)
        .u64(s.ffree)
        .u64(s.fsid)
        .u32(s.namelen)
    ),
  lopen: (tag: number, qid: Qid, iounit: number): Buffer => reply(T.Tlopen, tag, (w) => w.qid(qid).u32(iounit)),
  lcreate: (tag: number, qid: Qid, iounit: number): Buffer => reply(T.Tlcreate, tag, (w) => w.qid(qid).u32(iounit)),
  symlink: (tag: number, qid: Qid): Buffer => reply(T.Tsymlink, tag, (w) => w.qid(qid)),
  mknod: (tag: number, qid: Qid): Buffer => reply(T.Tmknod, tag, (w) => w.qid(qid)),
  rename: (tag: number): Buffer => reply(T.Trename, tag),
  readlink: (tag: number, target: string): Buffer => reply(T.Treadlink, tag, (w) => w.s(target)),
  getattr: (tag: number, a: Attr): Buffer =>
    reply(T.Tgetattr, tag, (w) =>
      w
        .u64(a.valid)
        .qid(a.qid)
        .u32(a.mode)
        .u32(a.uid)
        .u32(a.gid)
        .u64(a.nlink)
        .u64(a.rdev)
        .u64(a.size)
        .u64(a.blksize)
        .u64(a.blocks)
        .time(a.atime)
        .time(a.mtime)
        .time(a.ctime)
        .time(a.btime)
        .u64(a.gen)
        .u64(a.dataVersion)
    ),
  setattr: (tag: number): Buffer => reply(T.Tsetattr, tag),
  xattrwalk: (tag: number, size: bigint): Buffer => reply(T.Txattrwalk, tag, (w) => w.u64(size)),
  xattrcreate: (tag: number): Buffer => reply(T.Txattrcreate, tag),
  /** Packs entries until `count` bytes would be exceeded; the client paginates by offset. */
  readdir: (tag: number, entries: Dirent[], count: number): Buffer => {
    const data = new Writer();
    let used = 0;
    for (const e of entries) {
      const size = 13 + 8 + 1 + 2 + Buffer.byteLength(e.name, 'utf8');
      if (used + size > count) {
        break;
      }
      data.qid(e.qid).u64(e.offset).u8(e.type).s(e.name);
      used += size;
    }
    const body = data.body();
    return reply(T.Treaddir, tag, (w) => w.u32(body.length).bytes(body));
  },
  fsync: (tag: number): Buffer => reply(T.Tfsync, tag),
  lock: (tag: number, status: number): Buffer => reply(T.Tlock, tag, (w) => w.u8(status)),
  getlock: (tag: number, l: Omit<Lock, 'flags'>): Buffer =>
    reply(T.Tgetlock, tag, (w) => w.u8(l.type).u64(l.start).u64(l.length).u32(l.procId).s(l.clientId)),
  link: (tag: number): Buffer => reply(T.Tlink, tag),
  mkdir: (tag: number, qid: Qid): Buffer => reply(T.Tmkdir, tag, (w) => w.qid(qid)),
  renameat: (tag: number): Buffer => reply(T.Trenameat, tag),
  unlinkat: (tag: number): Buffer => reply(T.Tunlinkat, tag),
  read: (tag: number, data: Buffer): Buffer => reply(T.Tread, tag, (w) => w.u32(data.length).bytes(data)),
  write: (tag: number, count: number): Buffer => reply(T.Twrite, tag, (w) => w.u32(count)),
};

/** Request encoders, for a client and for tests. */
export const Treq = {
  version: (tag: number, msize: number, version: string): Buffer =>
    new Writer().u32(msize).s(version).frame(T.Tversion, tag),
  attach: (tag: number, fid: number, afid: number, uname: string, aname: string, nUname: number): Buffer =>
    new Writer().u32(fid).u32(afid).s(uname).s(aname).u32(nUname).frame(T.Tattach, tag),
  flush: (tag: number, oldtag: number): Buffer => new Writer().u16(oldtag).frame(T.Tflush, tag),
  walk: (tag: number, fid: number, newfid: number, names: string[]): Buffer => {
    const w = new Writer().u32(fid).u32(newfid).u16(names.length);
    names.forEach((n) => w.s(n));
    return w.frame(T.Twalk, tag);
  },
  clunk: (tag: number, fid: number): Buffer => new Writer().u32(fid).frame(T.Tclunk, tag),
  remove: (tag: number, fid: number): Buffer => new Writer().u32(fid).frame(T.Tremove, tag),
  statfs: (tag: number, fid: number): Buffer => new Writer().u32(fid).frame(T.Tstatfs, tag),
  lopen: (tag: number, fid: number, flags: number): Buffer => new Writer().u32(fid).u32(flags).frame(T.Tlopen, tag),
  lcreate: (tag: number, fid: number, name: string, flags: number, mode: number, gid: number): Buffer =>
    new Writer().u32(fid).s(name).u32(flags).u32(mode).u32(gid).frame(T.Tlcreate, tag),
  symlink: (tag: number, fid: number, name: string, target: string, gid: number): Buffer =>
    new Writer().u32(fid).s(name).s(target).u32(gid).frame(T.Tsymlink, tag),
  readlink: (tag: number, fid: number): Buffer => new Writer().u32(fid).frame(T.Treadlink, tag),
  getattr: (tag: number, fid: number, mask: bigint): Buffer => new Writer().u32(fid).u64(mask).frame(T.Tgetattr, tag),
  setattr: (tag: number, fid: number, a: Partial<SetAttr> & { valid: number }): Buffer =>
    new Writer()
      .u32(fid)
      .u32(a.valid)
      .u32(a.mode ?? 0)
      .u32(a.uid ?? 0)
      .u32(a.gid ?? 0)
      .u64(a.size ?? 0n)
      .time(a.atime ?? { sec: 0n, nsec: 0n })
      .time(a.mtime ?? { sec: 0n, nsec: 0n })
      .frame(T.Tsetattr, tag),
  readdir: (tag: number, fid: number, offset: bigint, count: number): Buffer =>
    new Writer().u32(fid).u64(offset).u32(count).frame(T.Treaddir, tag),
  fsync: (tag: number, fid: number): Buffer => new Writer().u32(fid).frame(T.Tfsync, tag),
  lock: (tag: number, fid: number, l: Lock): Buffer => new Writer().u32(fid).lock(l).frame(T.Tlock, tag),
  getlock: (tag: number, fid: number, l: Lock): Buffer => new Writer().u32(fid).lock(l).frame(T.Tgetlock, tag),
  link: (tag: number, dfid: number, fid: number, name: string): Buffer =>
    new Writer().u32(dfid).u32(fid).s(name).frame(T.Tlink, tag),
  mkdir: (tag: number, dfid: number, name: string, mode: number, gid: number): Buffer =>
    new Writer().u32(dfid).s(name).u32(mode).u32(gid).frame(T.Tmkdir, tag),
  renameat: (tag: number, olddirfid: number, oldname: string, newdirfid: number, newname: string): Buffer =>
    new Writer().u32(olddirfid).s(oldname).u32(newdirfid).s(newname).frame(T.Trenameat, tag),
  unlinkat: (tag: number, dirfid: number, name: string, flags: number): Buffer =>
    new Writer().u32(dirfid).s(name).u32(flags).frame(T.Tunlinkat, tag),
  read: (tag: number, fid: number, offset: bigint, count: number): Buffer =>
    new Writer().u32(fid).u64(offset).u32(count).frame(T.Tread, tag),
  write: (tag: number, fid: number, offset: bigint, data: Buffer): Buffer =>
    new Writer().u32(fid).u64(offset).u32(data.length).bytes(data).frame(T.Twrite, tag),
};

export type Reply =
  | { tag: number; type: typeof T.Rlerror; ecode: number }
  | { tag: number; type: number; qid?: Qid; iounit?: number }
  | { tag: number; type: number; msize: number; version: string }
  | { tag: number; type: number; qids: Qid[] }
  | ({ tag: number; type: number } & Attr)
  | { tag: number; type: number; entries: Dirent[] }
  | { tag: number; type: number; status: number }
  | { tag: number; type: number; lock: Omit<Lock, 'flags'> }
  | { tag: number; type: number; target: string }
  | { tag: number; type: number; statfs: Statfs }
  | { tag: number; type: number; data: Buffer }
  | { tag: number; type: number; count: number }
  | { tag: number; type: number; size: bigint };

/** Decodes a reply frame; the body layout follows from the reply type. */
export const decodeReply = (frame: Buffer): Reply => {
  const r = new Reader(frame);
  r.u32();
  const type = r.u8();
  const tag = r.u16();
  switch (type) {
    case T.Rlerror:
      return { tag, type, ecode: r.u32() };
    case T.Tversion + 1:
      return { tag, type, msize: r.u32(), version: r.s() };
    case T.Tattach + 1:
    case T.Tsymlink + 1:
    case T.Tmknod + 1:
    case T.Tmkdir + 1:
      return { tag, type, qid: r.qid() };
    case T.Tlopen + 1:
    case T.Tlcreate + 1:
      return { tag, type, qid: r.qid(), iounit: r.u32() };
    case T.Twalk + 1: {
      const n = r.u16();
      const qids: Qid[] = [];
      for (let i = 0; i < n; i++) {
        qids.push(r.qid());
      }
      return { tag, type, qids };
    }
    case T.Tgetattr + 1:
      return {
        tag,
        type,
        valid: r.u64(),
        qid: r.qid(),
        mode: r.u32(),
        uid: r.u32(),
        gid: r.u32(),
        nlink: r.u64(),
        rdev: r.u64(),
        size: r.u64(),
        blksize: r.u64(),
        blocks: r.u64(),
        atime: r.time(),
        mtime: r.time(),
        ctime: r.time(),
        btime: r.time(),
        gen: r.u64(),
        dataVersion: r.u64(),
      };
    case T.Treaddir + 1: {
      const count = r.u32();
      const end = r.remaining - count;
      const entries: Dirent[] = [];
      while (r.remaining > end) {
        entries.push({ qid: r.qid(), offset: r.u64(), type: r.u8(), name: r.s() });
      }
      return { tag, type, entries };
    }
    case T.Tlock + 1:
      return { tag, type, status: r.u8() };
    case T.Tgetlock + 1:
      return { tag, type, lock: { type: r.u8(), start: r.u64(), length: r.u64(), procId: r.u32(), clientId: r.s() } };
    case T.Treadlink + 1:
      return { tag, type, target: r.s() };
    case T.Tstatfs + 1:
      return {
        tag,
        type,
        statfs: {
          type: r.u32(),
          bsize: r.u32(),
          blocks: r.u64(),
          bfree: r.u64(),
          bavail: r.u64(),
          files: r.u64(),
          ffree: r.u64(),
          fsid: r.u64(),
          namelen: r.u32(),
        },
      };
    case T.Tread + 1: {
      const count = r.u32();
      return { tag, type, data: r.bytes(count) };
    }
    case T.Twrite + 1:
      return { tag, type, count: r.u32() };
    case T.Txattrwalk + 1:
      return { tag, type, size: r.u64() };
    default:
      return { tag, type }; // Rflush, Rclunk, Rremove, Rrename, Rsetattr, Rfsync, Rlink, Rrenameat, Runlinkat, Rxattrcreate
  }
};
