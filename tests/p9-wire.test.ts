import {
  AT_REMOVEDIR,
  decode,
  decodeReply,
  frames,
  GETATTR,
  LOCK_STATUS,
  LOCK_TYPE,
  MSIZE,
  QTDIR,
  R,
  T,
  Treq,
  VERSION,
  WireError,
  type Attr,
  type Dirent,
  type Lock,
} from '../src/p9/wire';

const qid = { type: QTDIR, version: 7, path: 0x1122334455667788n };

describe('9P2000.L wire', () => {
  it('frames: splits a stream into complete messages and keeps the remainder', () => {
    const a = Treq.version(0xffff, MSIZE, VERSION);
    const b = Treq.clunk(1, 42);
    const joined = Buffer.concat([a, b, Buffer.from([9, 0, 0])]); // a third frame's first 3 bytes
    const { frames: out, rest } = frames(joined);
    expect(out).toHaveLength(2);
    expect(out[0]!.equals(a)).toBe(true);
    expect(out[1]!.equals(b)).toBe(true);
    expect(rest).toEqual(Buffer.from([9, 0, 0]));
    expect(() => frames(Buffer.from([3, 0, 0, 0]))).toThrow(WireError);
  });

  it('decodes the handshake and the fid lifecycle', () => {
    expect(decode(Treq.version(0xffff, MSIZE, VERSION))).toEqual({
      tag: 0xffff,
      type: T.Tversion,
      msize: MSIZE,
      version: VERSION,
    });
    expect(decode(Treq.attach(1, 0, 0xffffffff, 'rowdy', '/s3', 0))).toEqual({
      tag: 1,
      type: T.Tattach,
      fid: 0,
      afid: 0xffffffff,
      uname: 'rowdy',
      aname: '/s3',
      nUname: 0,
    });
    expect(decode(Treq.walk(2, 0, 1, ['db', 'nuss.sqlite']))).toEqual({
      tag: 2,
      type: T.Twalk,
      fid: 0,
      newfid: 1,
      names: ['db', 'nuss.sqlite'],
    });
    expect(decode(Treq.walk(3, 1, 2, []))).toEqual({ tag: 3, type: T.Twalk, fid: 1, newfid: 2, names: [] });
    expect(decode(Treq.clunk(4, 2))).toEqual({ tag: 4, type: T.Tclunk, fid: 2 });
    expect(decode(Treq.flush(5, 4))).toEqual({ tag: 5, type: T.Tflush, oldtag: 4 });
  });

  it('decodes file operations with their flags and 64-bit fields intact', () => {
    expect(decode(Treq.lopen(1, 3, 0o102))).toEqual({ tag: 1, type: T.Tlopen, fid: 3, flags: 0o102 });
    expect(decode(Treq.lcreate(2, 3, 'new.txt', 0o101, 0o644, 1000))).toEqual({
      tag: 2,
      type: T.Tlcreate,
      fid: 3,
      name: 'new.txt',
      flags: 0o101,
      mode: 0o644,
      gid: 1000,
    });
    expect(decode(Treq.getattr(3, 3, GETATTR.ALL))).toEqual({ tag: 3, type: T.Tgetattr, fid: 3, mask: GETATTR.ALL });
    expect(decode(Treq.readdir(4, 3, 0xfffffffffn, 8192))).toEqual({
      tag: 4,
      type: T.Treaddir,
      fid: 3,
      offset: 0xfffffffffn,
      count: 8192,
    });
    expect(decode(Treq.read(5, 3, 2n ** 40n, 65536))).toEqual({
      tag: 5,
      type: T.Tread,
      fid: 3,
      offset: 2n ** 40n,
      count: 65536,
    });
    expect(decode(Treq.write(6, 3, 10n, Buffer.from('hello')))).toEqual({
      tag: 6,
      type: T.Twrite,
      fid: 3,
      offset: 10n,
      data: Buffer.from('hello'),
    });
    expect(decode(Treq.fsync(7, 3))).toEqual({ tag: 7, type: T.Tfsync, fid: 3 });
    expect(decode(Treq.mkdir(8, 0, 'dir', 0o755, 0))).toEqual({
      tag: 8,
      type: T.Tmkdir,
      dfid: 0,
      name: 'dir',
      mode: 0o755,
      gid: 0,
    });
    expect(decode(Treq.unlinkat(9, 0, 'dir', AT_REMOVEDIR))).toEqual({
      tag: 9,
      type: T.Tunlinkat,
      dirfid: 0,
      name: 'dir',
      flags: AT_REMOVEDIR,
    });
    expect(decode(Treq.renameat(10, 0, 'a', 5, 'b'))).toEqual({
      tag: 10,
      type: T.Trenameat,
      olddirfid: 0,
      oldname: 'a',
      newdirfid: 5,
      newname: 'b',
    });
    expect(decode(Treq.symlink(11, 0, 'lnk', '/s3/target', 0))).toEqual({
      tag: 11,
      type: T.Tsymlink,
      fid: 0,
      name: 'lnk',
      target: '/s3/target',
      gid: 0,
    });
    expect(decode(Treq.readlink(12, 3))).toEqual({ tag: 12, type: T.Treadlink, fid: 3 });
    expect(decode(Treq.link(13, 0, 3, 'hard'))).toEqual({ tag: 13, type: T.Tlink, dfid: 0, fid: 3, name: 'hard' });
    expect(decode(Treq.statfs(14, 0))).toEqual({ tag: 14, type: T.Tstatfs, fid: 0 });
    expect(decode(Treq.setattr(15, 3, { valid: 0x8, size: 4096n }))).toMatchObject({
      tag: 15,
      type: T.Tsetattr,
      fid: 3,
      valid: 0x8,
      size: 4096n,
    });
  });

  it('decodes locks, including the client id string', () => {
    const lock: Lock = { type: LOCK_TYPE.WRLCK, flags: 0, start: 0n, length: 0n, procId: 13, clientId: 'host-1' };
    expect(decode(Treq.lock(1, 3, lock))).toEqual({ tag: 1, type: T.Tlock, fid: 3, lock });
    expect(decode(Treq.getlock(2, 3, lock))).toEqual({ tag: 2, type: T.Tgetlock, fid: 3, lock });
  });

  it('handles UTF-8 names and rejects malformed frames', () => {
    expect(decode(Treq.walk(1, 0, 1, ['données', '文件']))).toMatchObject({ names: ['données', '文件'] });
    const short = Treq.clunk(1, 2).subarray(0, 9); // header says 11 bytes
    expect(() => decode(short)).toThrow(WireError);
    const bad = Buffer.from(Treq.clunk(1, 2));
    bad[4] = 200; // unknown type
    expect(() => decode(bad)).toThrow(/unknown message type 200/);
  });

  describe('replies round-trip', () => {
    it('version, attach, walk, lopen, lerror', () => {
      expect(decodeReply(R.version(0xffff, 8192, VERSION))).toEqual({
        tag: 0xffff,
        type: T.Tversion + 1,
        msize: 8192,
        version: VERSION,
      });
      expect(decodeReply(R.attach(1, qid))).toEqual({ tag: 1, type: T.Tattach + 1, qid });
      expect(decodeReply(R.walk(2, [qid, { ...qid, type: 0 }]))).toEqual({
        tag: 2,
        type: T.Twalk + 1,
        qids: [qid, { ...qid, type: 0 }],
      });
      expect(decodeReply(R.lopen(3, qid, 0))).toEqual({ tag: 3, type: T.Tlopen + 1, qid, iounit: 0 });
      expect(decodeReply(R.lerror(4, 116))).toEqual({ tag: 4, type: T.Rlerror, ecode: 116 });
      expect(decodeReply(R.clunk(5))).toEqual({ tag: 5, type: T.Tclunk + 1 });
    });

    it('getattr carries every field', () => {
      const attr: Attr = {
        valid: GETATTR.BASIC,
        qid: { type: 0, version: 3, path: 99n },
        mode: 0o100644,
        uid: 1000,
        gid: 1000,
        nlink: 1n,
        rdev: 0n,
        size: 4710400n,
        blksize: 4096n,
        blocks: 9200n,
        atime: { sec: 1791316328n, nsec: 1n },
        mtime: { sec: 1791316329n, nsec: 2n },
        ctime: { sec: 1791316330n, nsec: 3n },
        btime: { sec: 0n, nsec: 0n },
        gen: 0n,
        dataVersion: 42n,
      };
      expect(decodeReply(R.getattr(1, attr))).toEqual({ tag: 1, type: T.Tgetattr + 1, ...attr });
    });

    it('readdir packs what fits in count and no more', () => {
      const entries: Dirent[] = ['a.txt', 'b.txt', 'a-much-longer-file-name.sqlite'].map((name, i) => ({
        qid: { type: 0, version: 0, path: BigInt(i + 1) },
        offset: BigInt(i + 1),
        type: 8,
        name,
      }));
      const all = decodeReply(R.readdir(1, entries, 8192));
      expect(all).toEqual({ tag: 1, type: T.Treaddir + 1, entries });
      // each short entry is 13 + 8 + 1 + 2 + 5 = 29 bytes: room for two
      const some = decodeReply(R.readdir(2, entries, 60)) as { entries: Dirent[] };
      expect(some.entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt']);
    });

    it('lock, getlock, readlink, statfs, read, write', () => {
      expect(decodeReply(R.lock(1, LOCK_STATUS.BLOCKED))).toEqual({
        tag: 1,
        type: T.Tlock + 1,
        status: LOCK_STATUS.BLOCKED,
      });
      const held = { type: LOCK_TYPE.WRLCK, start: 0n, length: 0n, procId: 7, clientId: 'other' };
      expect(decodeReply(R.getlock(2, held))).toEqual({ tag: 2, type: T.Tgetlock + 1, lock: held });
      expect(decodeReply(R.readlink(3, '/s3/db'))).toEqual({ tag: 3, type: T.Treadlink + 1, target: '/s3/db' });
      const statfs = {
        type: 0x01021997,
        bsize: 4096,
        blocks: 1n,
        bfree: 2n,
        bavail: 3n,
        files: 4n,
        ffree: 5n,
        fsid: 6n,
        namelen: 255,
      };
      expect(decodeReply(R.statfs(4, statfs))).toEqual({ tag: 4, type: T.Tstatfs + 1, statfs });
      expect(decodeReply(R.read(5, Buffer.from('bytes')))).toEqual({
        tag: 5,
        type: T.Tread + 1,
        data: Buffer.from('bytes'),
      });
      expect(decodeReply(R.write(6, 5))).toEqual({ tag: 6, type: T.Twrite + 1, count: 5 });
    });
  });
});
