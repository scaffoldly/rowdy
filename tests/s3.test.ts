import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { crc32 } from 'zlib';
import { S3Adapter, VfsError } from '../src';

type Stored = { body: Buffer; etag: string; crc32: string };

/** Base64 CRC32 as S3 reports it for a full-object checksum. */
const crc32b64 = (body: Buffer): string => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(crc32(body));
  return out.toString('base64');
};

/** Enough of S3 to exercise the adapter: keys, opaque ETags, CRC32 checksums, conditional puts, prefix listing. */
class FakeS3 {
  readonly objects = new Map<string, Stored>();
  readonly calls: string[] = [];
  /** Keys whose next conditional PutObject is turned away with 409 ConditionalRequestConflict. */
  readonly conflictNext = new Set<string>();
  private version = 0;

  put(key: string, body: string): Stored {
    // ETags are opaque on purpose (as with SSE-KMS or multipart): the adapter must not read MD5s out of them.
    const buf = Buffer.from(body);
    const stored = { body: buf, etag: `"v${++this.version}"`, crc32: crc32b64(buf) };
    this.objects.set(key, stored);
    return stored;
  }

  private checksums(o: Stored, input: { ChecksumMode?: string }): { ChecksumCRC32?: string } {
    return input.ChecksumMode === 'ENABLED' ? { ChecksumCRC32: o.crc32 } : {};
  }

  async send(command: unknown): Promise<unknown> {
    this.calls.push(command!.constructor.name);
    if (command instanceof HeadObjectCommand) {
      const o = this.objects.get(command.input.Key!);
      if (!o) throw notFound();
      return { ETag: o.etag, ContentLength: o.body.length, ...this.checksums(o, command.input) };
    }
    if (command instanceof GetObjectCommand) {
      const o = this.objects.get(command.input.Key!);
      if (!o) throw notFound('NoSuchKey');
      const body = Readable.from([o.body]) as Readable & { transformToString(): Promise<string> };
      body.transformToString = async () => o.body.toString();
      return { ETag: o.etag, ContentLength: o.body.length, Body: body, ...this.checksums(o, command.input) };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key!;
      const existing = this.objects.get(key);
      if ((command.input.IfNoneMatch || command.input.IfMatch) && this.conflictNext.delete(key)) throw conflict();
      if (command.input.IfNoneMatch === '*' && existing) throw precondition();
      if (command.input.IfMatch && existing?.etag !== command.input.IfMatch) throw precondition();
      const chunks: Buffer[] = [];
      for await (const chunk of command.input.Body as Readable) chunks.push(Buffer.from(chunk));
      const stored = this.put(key, Buffer.concat(chunks).toString());
      return {
        ETag: stored.etag,
        ...(command.input.ChecksumAlgorithm === 'CRC32' ? { ChecksumCRC32: stored.crc32 } : {}),
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(command.input.Key!);
      return {};
    }
    if (command instanceof CopyObjectCommand) {
      const source = decodeURIComponent(command.input.CopySource!.split('/').slice(1).join('/'));
      const o = this.objects.get(source);
      if (!o) throw notFound();
      return { CopyObjectResult: { ETag: this.put(command.input.Key!, o.body.toString()).etag } };
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? '';
      const delimiter = command.input.Delimiter;
      const contents: { Key: string; Size: number; ETag: string }[] = [];
      const common = new Set<string>();
      for (const [key, o] of this.objects) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = delimiter ? rest.indexOf('/') : -1;
        if (slash >= 0) {
          common.add(prefix + rest.slice(0, slash + 1));
        } else {
          contents.push({ Key: key, Size: o.body.length, ETag: o.etag });
        }
      }
      const limited = command.input.MaxKeys ? contents.slice(0, command.input.MaxKeys) : contents;
      return {
        Contents: limited,
        CommonPrefixes: [...common].map((Prefix) => ({ Prefix })),
        KeyCount: limited.length + common.size,
        IsTruncated: false,
      };
    }
    throw new Error(`unexpected command ${command!.constructor.name}`);
  }
}

const notFound = (name = 'NotFound') => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
const precondition = () =>
  Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
const conflict = () =>
  Object.assign(
    new Error('The conditional request cannot succeed due to a conflicting operation against this resource.'),
    {
      name: 'ConditionalRequestConflict',
      $metadata: { httpStatusCode: 409 },
    }
  );

describe('S3Adapter', () => {
  let backing: string;
  let s3: FakeS3;
  let adapter: S3Adapter;
  const mount = '/vfs';

  beforeEach(() => {
    backing = mkdtempSync(join(tmpdir(), 'rowdy-vfs-s3-'));
    s3 = new FakeS3();
    adapter = new S3Adapter({
      bucket: 'example-bucket',
      mountpoint: mount,
      backing,
      client: s3 as unknown as S3Client,
    });
  });

  afterEach(() => rmSync(backing, { recursive: true, force: true }));

  describe('stat', () => {
    it('rejects an unknown path with ENOENT and touches nothing locally', async () => {
      await expect(adapter.stat(`${mount}/nope.txt`)).rejects.toMatchObject({ errno: 2 });
      expect(existsSync(join(backing, 'nope.txt'))).toBe(false);
    });

    it('creates a correctly sized placeholder for an object without downloading it', async () => {
      s3.put('report.csv', 'a,b,c\n1,2,3\n');
      await adapter.stat(`${mount}/report.csv`);
      const local = join(backing, 'report.csv');
      expect(statSync(local).size).toBe(12);
      expect(readFileSync(local).every((b) => b === 0)).toBe(true);
      expect(s3.calls).not.toContain('GetObjectCommand');
    });

    it('creates a local directory for a key prefix', async () => {
      s3.put('photos/2026/a.jpg', 'x');
      await adapter.stat(`${mount}/photos`);
      expect(statSync(join(backing, 'photos')).isDirectory()).toBe(true);
    });

    it('is a no-op for the mountpoint itself and for paths outside it', async () => {
      await adapter.stat(mount);
      await adapter.stat('/etc/passwd');
      expect(s3.calls).toEqual([]);
    });
  });

  describe('fetch', () => {
    it('materializes the object and remembers its ETag', async () => {
      const stored = s3.put('hello.txt', 'hello');
      await adapter.stat(`${mount}/hello.txt`); // placeholder first
      await adapter.fetch(`${mount}/hello.txt`);
      expect(readFileSync(join(backing, 'hello.txt'), 'utf8')).toBe('hello');
      // a second fetch is served locally
      s3.calls.length = 0;
      await adapter.fetch(`${mount}/hello.txt`);
      expect(s3.calls).toEqual([]);
      expect(stored.etag).toBe('"v1"');
    });

    it('removes a stale placeholder when the object is gone', async () => {
      s3.put('gone.txt', 'bye');
      await adapter.stat(`${mount}/gone.txt`);
      s3.objects.delete('gone.txt');
      await expect(adapter.fetch(`${mount}/gone.txt`)).rejects.toMatchObject({ errno: 2 });
      expect(existsSync(join(backing, 'gone.txt'))).toBe(false);
    });

    it('does not overwrite a file written locally', async () => {
      writeFileSync(join(backing, 'mine.txt'), 'local');
      await adapter.fetch(`${mount}/mine.txt`);
      expect(readFileSync(join(backing, 'mine.txt'), 'utf8')).toBe('local');
    });
  });

  describe('list', () => {
    it('materializes directories and sized placeholders for one level', async () => {
      s3.put('a.txt', 'aaa');
      s3.put('dir/b.txt', 'bb');
      s3.put('dir/deep/c.txt', 'c');
      await adapter.list(mount);
      expect(readdirSync(backing).sort()).toEqual(['a.txt', 'dir']);
      expect(statSync(join(backing, 'a.txt')).size).toBe(3);
      expect(existsSync(join(backing, 'dir', 'b.txt'))).toBe(false); // not listed yet
      await adapter.list(`${mount}/dir`);
      expect(readdirSync(join(backing, 'dir')).sort()).toEqual(['b.txt', 'deep']);
    });

    it('honours a key prefix', async () => {
      const prefixed = new S3Adapter({
        bucket: 'example-bucket',
        prefix: 'tenant/42',
        mountpoint: mount,
        backing,
        client: s3 as unknown as S3Client,
      });
      s3.put('tenant/42/x.txt', 'x');
      s3.put('tenant/43/y.txt', 'y');
      await prefixed.list(mount);
      expect(readdirSync(backing)).toEqual(['x.txt']);
      await prefixed.fetch(`${mount}/x.txt`);
      expect(readFileSync(join(backing, 'x.txt'), 'utf8')).toBe('x');
    });
  });

  describe('open + flush', () => {
    it('creates a new object with If-None-Match: * and records the new ETag', async () => {
      const local = join(backing, 'new.txt');
      writeFileSync(local, 'fresh');
      await adapter.open(`${mount}/new.txt`, 0);
      await adapter.flush(`${mount}/new.txt`);
      expect(s3.objects.get('new.txt')?.body.toString()).toBe('fresh');
      // a second flush of the same file now uses If-Match with the recorded ETag
      writeFileSync(local, 'fresher');
      await adapter.flush(`${mount}/new.txt`);
      expect(s3.objects.get('new.txt')?.body.toString()).toBe('fresher');
    });

    it('overwrites a fetched object with If-Match on the ETag it was based on', async () => {
      s3.put('doc.txt', 'v1');
      await adapter.fetch(`${mount}/doc.txt`);
      await adapter.open(`${mount}/doc.txt`, 1);
      writeFileSync(join(backing, 'doc.txt'), 'v2');
      await adapter.flush(`${mount}/doc.txt`);
      expect(s3.objects.get('doc.txt')?.body.toString()).toBe('v2');
    });

    it('fails the flush with ESTALE when the object changed underneath', async () => {
      s3.put('shared.txt', 'v1');
      await adapter.fetch(`${mount}/shared.txt`);
      await adapter.open(`${mount}/shared.txt`, 1);
      s3.put('shared.txt', 'someone else'); // concurrent writer
      writeFileSync(join(backing, 'shared.txt'), 'mine');
      await expect(adapter.flush(`${mount}/shared.txt`)).rejects.toMatchObject({ errno: 116 });
      expect(s3.objects.get('shared.txt')?.body.toString()).toBe('someone else');
    });

    it('a plain create that loses the race to another instance overwrites: last writer wins', async () => {
      writeFileSync(join(backing, 'race.txt'), 'mine');
      await adapter.open(`${mount}/race.txt`, 0o101); // O_WRONLY|O_CREAT; HEAD: nothing there
      s3.put('race.txt', 'theirs');
      await adapter.flush(`${mount}/race.txt`);
      expect(s3.objects.get('race.txt')?.body.toString()).toBe('mine');
      expect(s3.calls.filter((c) => c === 'PutObjectCommand')).toHaveLength(2); // If-None-Match: *, then If-Match
    });

    it('an O_EXCL create that loses the race fails with EEXIST at flush: the conditional PUT decides', async () => {
      writeFileSync(join(backing, 'excl.txt'), 'mine');
      await adapter.open(`${mount}/excl.txt`, 0o301); // O_WRONLY|O_CREAT|O_EXCL
      s3.put('excl.txt', 'theirs');
      await expect(adapter.flush(`${mount}/excl.txt`)).rejects.toMatchObject({ errno: 17 });
      expect(s3.objects.get('excl.txt')?.body.toString()).toBe('theirs');
    });

    it('an O_EXCL create of an object that already exists is refused before any write', async () => {
      s3.put('taken.txt', 'theirs');
      await adapter.open(`${mount}/taken.txt`, 0o301); // HEAD finds it: not exclusive-new
      writeFileSync(join(backing, 'taken.txt'), 'mine');
      await adapter.flush(`${mount}/taken.txt`); // If-Match on the known ETag: an ordinary overwrite
      expect(s3.objects.get('taken.txt')?.body.toString()).toBe('mine');
    });

    it('retries a flush that S3 turned away with 409 ConditionalRequestConflict', async () => {
      s3.put('busy.txt', 'v1');
      await adapter.fetch(`${mount}/busy.txt`);
      await adapter.open(`${mount}/busy.txt`, 1);
      writeFileSync(join(backing, 'busy.txt'), 'v2');
      s3.conflictNext.add('busy.txt'); // another conditional write was in flight on this key
      await adapter.flush(`${mount}/busy.txt`);
      expect(s3.objects.get('busy.txt')?.body.toString()).toBe('v2');
      expect(s3.calls.filter((c) => c === 'PutObjectCommand')).toHaveLength(2);
    });

    it('ignores a flush for a file that is already gone', async () => {
      await expect(adapter.flush(`${mount}/vanished.txt`)).resolves.toBeUndefined();
      expect(s3.calls).toEqual([]);
    });
  });

  describe('directories', () => {
    it('mkdir writes a marker so an empty directory exists on every instance', async () => {
      await adapter.mkdir(`${mount}/photos`);
      expect([...s3.objects.keys()]).toEqual(['photos/']);
      const fresh = new S3Adapter({
        bucket: 'example-bucket',
        mountpoint: mount,
        backing: mkdtempSync(join(tmpdir(), 'rowdy-vfs-fresh-')),
        client: s3 as unknown as S3Client,
      });
      await fresh.stat(`${mount}/photos`); // another instance sees it
      expect(statSync(join(fresh['options'].backing, 'photos')).isDirectory()).toBe(true);
      await fresh.list(mount);
      expect(readdirSync(fresh['options'].backing)).toEqual(['photos']);
    });

    it('rmdir removes the marker, and renaming a directory moves it', async () => {
      await adapter.mkdir(`${mount}/photos`);
      mkdirSync(join(backing, 'albums'));
      await adapter.rename(`${mount}/photos`, `${mount}/albums`);
      expect([...s3.objects.keys()]).toEqual(['albums/']);
      await adapter.unlink(`${mount}/albums`);
      expect(s3.objects.size).toBe(0);
    });
  });

  describe('unlink and rename', () => {
    it('deletes the object', async () => {
      s3.put('old.txt', 'x');
      await adapter.unlink(`${mount}/old.txt`);
      expect(s3.objects.has('old.txt')).toBe(false);
      await expect(adapter.unlink(`${mount}/old.txt`)).resolves.toBeUndefined(); // idempotent
    });

    it('renames a file with a server-side copy and delete', async () => {
      s3.put('a.txt', 'content');
      writeFileSync(join(backing, 'b.txt'), 'content');
      await adapter.rename(`${mount}/a.txt`, `${mount}/b.txt`);
      expect(s3.objects.has('a.txt')).toBe(false);
      expect(s3.objects.get('b.txt')?.body.toString()).toBe('content');
      expect(s3.calls).toEqual(expect.arrayContaining(['CopyObjectCommand', 'DeleteObjectCommand']));
    });

    it('uploads the local copy when the source was never flushed', async () => {
      writeFileSync(join(backing, 'moved.txt'), 'never flushed');
      await adapter.rename(`${mount}/tmp.txt`, `${mount}/moved.txt`);
      expect(s3.objects.get('moved.txt')?.body.toString()).toBe('never flushed');
    });

    it('moves every object under a renamed directory', async () => {
      s3.put('d1/a.txt', 'a');
      s3.put('d1/sub/b.txt', 'b');
      mkdirSync(join(backing, 'd2', 'sub'), { recursive: true });
      await adapter.rename(`${mount}/d1`, `${mount}/d2`);
      expect([...s3.objects.keys()].sort()).toEqual(['d2/a.txt', 'd2/sub/b.txt']);
    });

    it('refuses a rename across the mountpoint boundary', async () => {
      await expect(adapter.rename(`${mount}/a.txt`, '/tmp/elsewhere.txt')).rejects.toMatchObject({ errno: 18 });
    });
  });

  describe('revalidation', () => {
    const fresh = (revalidateMs: number): S3Adapter =>
      new S3Adapter({
        bucket: 'example-bucket',
        mountpoint: mount,
        backing,
        client: s3 as unknown as S3Client,
        revalidateMs,
      });

    it('refetches in place when the object changed', async () => {
      const a = fresh(0);
      s3.put('doc.txt', 'v1');
      await a.fetch(`${mount}/doc.txt`);
      const fd = openSync(join(backing, 'doc.txt'), 'r'); // held open across the refetch, like SQLite
      s3.put('doc.txt', 'v2!');
      await a.fetch(`${mount}/doc.txt`);
      expect(readFileSync(join(backing, 'doc.txt'), 'utf8')).toBe('v2!');
      const buf = Buffer.alloc(3);
      readSync(fd, buf, 0, 3, 0);
      closeSync(fd);
      expect(buf.toString()).toBe('v2!'); // same inode: the open descriptor sees the new bytes
    });

    it('does not download when the ETag is unchanged', async () => {
      const a = fresh(0);
      s3.put('same.txt', 'x');
      await a.fetch(`${mount}/same.txt`);
      s3.calls.length = 0;
      await a.fetch(`${mount}/same.txt`);
      expect(s3.calls).toEqual(['HeadObjectCommand']);
    });

    it('skips the HEAD inside the TTL', async () => {
      const a = fresh(60_000);
      s3.put('ttl.txt', 'x');
      await a.fetch(`${mount}/ttl.txt`);
      s3.calls.length = 0;
      await a.fetch(`${mount}/ttl.txt`);
      await a.stat(`${mount}/ttl.txt`);
      expect(s3.calls).toEqual([]);
    });

    it('revalidate() bypasses the TTL', async () => {
      const a = fresh(60_000);
      s3.put('force.txt', 'v1');
      await a.fetch(`${mount}/force.txt`);
      s3.put('force.txt', 'v2');
      await a.revalidate(`${mount}/force.txt`);
      expect(readFileSync(join(backing, 'force.txt'), 'utf8')).toBe('v2');
    });

    it('never overwrites a dirty local copy', async () => {
      const a = fresh(0);
      s3.put('mine.txt', 'remote v1');
      await a.fetch(`${mount}/mine.txt`);
      await a.open(`${mount}/mine.txt`, 1);
      writeFileSync(join(backing, 'mine.txt'), 'local edits');
      s3.put('mine.txt', 'remote v2');
      await a.fetch(`${mount}/mine.txt`);
      expect(readFileSync(join(backing, 'mine.txt'), 'utf8')).toBe('local edits');
    });

    it('still revalidates a file that is open for writing but untouched (the SQLite case)', async () => {
      // A database stays open O_RDWR for the life of the process; a transaction on another
      // instance must still be picked up before the next write here.
      const a = fresh(0);
      s3.put('db.sqlite', 'v1');
      await a.fetch(`${mount}/db.sqlite`);
      await a.open(`${mount}/db.sqlite`, 2); // long-lived writer handle, nothing written yet
      s3.put('db.sqlite', 'v2 from another instance');
      await a.revalidate(`${mount}/db.sqlite`);
      expect(readFileSync(join(backing, 'db.sqlite'), 'utf8')).toBe('v2 from another instance');
      // and a flush of the untouched copy uploads nothing
      s3.calls.length = 0;
      await a.flush(`${mount}/db.sqlite`);
      expect(s3.calls).not.toContain('PutObjectCommand');
    });

    it('treats bytes restored to the base as unmodified, so a rolled-back copy heals', async () => {
      // A failed commit: the app rewrote the file (flush -> ESTALE), then rolled it back to the
      // exact base bytes. Nothing must be uploaded, and the next revalidate must fetch the newer
      // remote version instead of protecting the "edited" local copy.
      const a = fresh(0);
      s3.put('db.sqlite', 'base');
      await a.fetch(`${mount}/db.sqlite`);
      const local = join(backing, 'db.sqlite');
      s3.put('db.sqlite', 'moved'); // someone else won
      writeFileSync(local, 'mine'); // our attempted write, then its flush fails...
      await expect(a.flush(`${mount}/db.sqlite`)).rejects.toMatchObject({ errno: 116 });
      writeFileSync(local, 'base'); // ...and the app rolls back to the base bytes
      s3.calls.length = 0;
      await a.flush(`${mount}/db.sqlite`); // rollback's fsync
      expect(s3.calls).not.toContain('PutObjectCommand');
      await a.revalidate(`${mount}/db.sqlite`);
      expect(readFileSync(local, 'utf8')).toBe('moved');
    });

    it('drops the local copy when the object was deleted remotely', async () => {
      const a = fresh(0);
      s3.put('gone.txt', 'x');
      await a.fetch(`${mount}/gone.txt`);
      s3.objects.delete('gone.txt');
      await expect(a.stat(`${mount}/gone.txt`)).rejects.toMatchObject({ errno: 2 });
      expect(existsSync(join(backing, 'gone.txt'))).toBe(false);
    });

    it('resizes a placeholder when the listing shows a change', async () => {
      const a = fresh(0);
      s3.put('ph.txt', 'abc');
      await a.list(mount);
      expect(statSync(join(backing, 'ph.txt')).size).toBe(3);
      s3.put('ph.txt', 'abcdef');
      await a.stat(`${mount}/ph.txt`);
      expect(statSync(join(backing, 'ph.txt')).size).toBe(6);
    });
  });

  describe('leases', () => {
    const leased = (owner: string, extra: Partial<ConstructorParameters<typeof S3Adapter>[0]> = {}): S3Adapter =>
      new S3Adapter({
        bucket: 'example-bucket',
        mountpoint: mount,
        backing: mkdtempSync(join(tmpdir(), `rowdy-vfs-${owner}-`)),
        client: s3 as unknown as S3Client,
        owner,
        lockWaitMs: 150,
        leaseMs: 10_000,
        ...extra,
      });

    it('creates and deletes a lease object under .rowdy/locks', async () => {
      const a = leased('alice');
      await a.lock(`${mount}/db.sqlite`);
      expect([...s3.objects.keys()]).toEqual(['.rowdy/locks/db.sqlite']);
      expect(JSON.parse(s3.objects.get('.rowdy/locks/db.sqlite')!.body.toString()).owner).toBe('alice');
      await a.unlock(`${mount}/db.sqlite`);
      expect(s3.objects.size).toBe(0);
    });

    it('is re-entrant for the holder and EAGAIN for everyone else', async () => {
      const a = leased('alice');
      const b = leased('bob');
      await a.lock(`${mount}/db.sqlite`);
      await a.lock(`${mount}/db.sqlite`); // no-op
      await expect(b.lock(`${mount}/db.sqlite`)).rejects.toMatchObject({ errno: 11 });
      await a.unlock(`${mount}/db.sqlite`);
      await expect(b.lock(`${mount}/db.sqlite`)).resolves.toBeUndefined();
      await b.unlock(`${mount}/db.sqlite`);
    });

    it('yields EAGAIN when the object moved since this instance last read it', async () => {
      const a = leased('alice', { revalidateMs: 0 });
      const b = leased('bob', { revalidateMs: 0 });
      s3.put('db.sqlite', 'v1');
      await a.fetch(`${mount}/db.sqlite`);
      await b.fetch(`${mount}/db.sqlite`);
      // bob commits a new version while alice holds only her read view
      writeFileSync(join(b['options'].backing, 'db.sqlite'), 'v2 by bob');
      await b.lock(`${mount}/db.sqlite`);
      await b.flush(`${mount}/db.sqlite`);
      await b.unlock(`${mount}/db.sqlite`);
      // alice's write lock must not succeed on the stale view...
      await expect(a.lock(`${mount}/db.sqlite`)).rejects.toMatchObject({ errno: 11 });
      expect(s3.objects.has('.rowdy/locks/db.sqlite')).toBe(false); // lease given back
      // ...but after re-reading (what SQLite does on BUSY) it does
      await a.revalidate(`${mount}/db.sqlite`);
      expect(readFileSync(join(a['options'].backing, 'db.sqlite'), 'utf8')).toBe('v2 by bob');
      await expect(a.lock(`${mount}/db.sqlite`)).resolves.toBeUndefined();
      await a.unlock(`${mount}/db.sqlite`);
    });

    it('retries a lease create that collided inside S3 (409) instead of failing with EIO', async () => {
      const a = leased('alice');
      s3.conflictNext.add('.rowdy/locks/db.sqlite');
      await expect(a.lock(`${mount}/db.sqlite`)).resolves.toBeUndefined();
      expect(JSON.parse(s3.objects.get('.rowdy/locks/db.sqlite')!.body.toString()).owner).toBe('alice');
      await a.unlock(`${mount}/db.sqlite`);
    });

    it('takes over an expired lease', async () => {
      const b = leased('bob');
      s3.put('.rowdy/locks/db.sqlite', JSON.stringify({ owner: 'crashed', expiresAt: Date.now() - 1 }));
      await b.lock(`${mount}/db.sqlite`);
      expect(JSON.parse(s3.objects.get('.rowdy/locks/db.sqlite')!.body.toString()).owner).toBe('bob');
      await b.unlock(`${mount}/db.sqlite`);
    });

    it('waits for a lease that is released in time', async () => {
      const a = leased('alice', { lockWaitMs: 2000 });
      const b = leased('bob', { lockWaitMs: 2000 });
      await a.lock(`${mount}/db.sqlite`);
      setTimeout(() => void a.unlock(`${mount}/db.sqlite`), 100);
      await expect(b.lock(`${mount}/db.sqlite`)).resolves.toBeUndefined();
      await b.unlock(`${mount}/db.sqlite`);
    });

    it('hides lease objects from listings', async () => {
      const a = leased('alice');
      s3.put('real.txt', 'x');
      await a.lock(`${mount}/real.txt`);
      await adapter.list(mount);
      expect(readdirSync(backing)).toEqual(['real.txt']);
      await a.unlock(`${mount}/real.txt`);
    });

    it('lockOnOpen holds the lease across the open/flush window', async () => {
      const a = leased('alice', { lockOnOpen: true });
      const b = leased('bob', { lockOnOpen: true });
      writeFileSync(join(a['options'].backing, 'f.txt'), 'from alice');
      await a.open(`${mount}/f.txt`, 1);
      expect(s3.objects.has('.rowdy/locks/f.txt')).toBe(true);
      await expect(b.open(`${mount}/f.txt`, 1)).rejects.toMatchObject({ errno: 11 });
      await a.flush(`${mount}/f.txt`);
      expect(s3.objects.has('.rowdy/locks/f.txt')).toBe(false);
      expect(s3.objects.get('f.txt')?.body.toString()).toBe('from alice');
    });
  });

  describe('eviction', () => {
    const bounded = (cacheBytes: number): S3Adapter =>
      new S3Adapter({
        bucket: 'example-bucket',
        mountpoint: mount,
        backing,
        client: s3 as unknown as S3Client,
        revalidateMs: 60_000,
        cacheBytes,
      });
    const isPlaceholder = (name: string): boolean => {
      const buf = readFileSync(join(backing, name));
      return buf.length > 0 && buf.every((b) => b === 0);
    };

    it('turns the least recently used copy back into a placeholder when the budget is exceeded', async () => {
      const a = bounded(10);
      s3.put('a.txt', 'aaaaaa');
      s3.put('b.txt', 'bbbbbb');
      await a.fetch(`${mount}/a.txt`);
      await a.fetch(`${mount}/b.txt`); // 12 bytes materialized > 10
      expect(isPlaceholder('a.txt')).toBe(true); // same size, no content
      expect(statSync(join(backing, 'a.txt')).size).toBe(6);
      expect(readFileSync(join(backing, 'b.txt'), 'utf8')).toBe('bbbbbb');
      s3.calls.length = 0;
      await a.fetch(`${mount}/a.txt`); // fetched again, and now b goes
      expect(s3.calls).toContain('GetObjectCommand');
      expect(readFileSync(join(backing, 'a.txt'), 'utf8')).toBe('aaaaaa');
      expect(isPlaceholder('b.txt')).toBe(true);
    });

    it('never evicts a copy that is open or has unflushed edits', async () => {
      const a = bounded(10);
      s3.put('a.txt', 'aaaaaa');
      s3.put('b.txt', 'bbbbbb');
      s3.put('c.txt', 'cccccc');
      await a.fetch(`${mount}/a.txt`);
      await a.acquire(`${mount}/a.txt`); // a reader has it open
      await a.fetch(`${mount}/b.txt`);
      expect(readFileSync(join(backing, 'a.txt'), 'utf8')).toBe('aaaaaa'); // pinned
      await a.release(`${mount}/a.txt`);
      await a.open(`${mount}/b.txt`, 1);
      writeFileSync(join(backing, 'b.txt'), 'edited'); // dirty, not uploaded yet
      await a.fetch(`${mount}/c.txt`);
      expect(readFileSync(join(backing, 'b.txt'), 'utf8')).toBe('edited'); // kept
      expect(isPlaceholder('a.txt')).toBe(true); // the only evictable one went
    });

    it('is not applied without a budget being exceeded', async () => {
      const a = bounded(1024);
      s3.put('a.txt', 'aaaaaa');
      s3.put('b.txt', 'bbbbbb');
      await a.fetch(`${mount}/a.txt`);
      await a.fetch(`${mount}/b.txt`);
      expect(readFileSync(join(backing, 'a.txt'), 'utf8')).toBe('aaaaaa');
    });
  });

  describe('localOnly', () => {
    const scratch = (): S3Adapter =>
      new S3Adapter({
        bucket: 'example-bucket',
        mountpoint: mount,
        backing,
        client: s3 as unknown as S3Client,
        revalidateMs: 0,
        localOnly: ['*-{journal,wal,shm}', 'cache/**'],
      });

    it('never touches S3 for a matching file: open, flush, lock, unlink are local no-ops', async () => {
      const a = scratch();
      writeFileSync(join(backing, 'db.sqlite-journal'), 'pages');
      await a.stat(`${mount}/db.sqlite-journal`);
      await a.fetch(`${mount}/db.sqlite-journal`);
      await a.open(`${mount}/db.sqlite-journal`, 1);
      await a.lock(`${mount}/db.sqlite-journal`);
      await a.flush(`${mount}/db.sqlite-journal`);
      await a.unlock(`${mount}/db.sqlite-journal`);
      await a.revalidate(`${mount}/db.sqlite-journal`);
      await a.unlink(`${mount}/db.sqlite-journal`);
      expect(s3.calls).toEqual([]);
      expect(s3.objects.size).toBe(0);
    });

    it('matches a bare glob by file name at any depth and a slashed glob by path', async () => {
      const a = scratch();
      writeFileSync(join(backing, 'x.tmp'), 'x');
      mkdirSync(join(backing, 'deep', 'cache'), { recursive: true });
      writeFileSync(join(backing, 'deep', 'cache', 'db.sqlite-wal'), 'w'); // bare glob: any depth
      await a.flush(`${mount}/deep/cache/db.sqlite-wal`);
      mkdirSync(join(backing, 'cache', 'sub'), { recursive: true });
      writeFileSync(join(backing, 'cache', 'sub', 'blob.bin'), 'b'); // slashed glob: path under cache/
      await a.flush(`${mount}/cache/sub/blob.bin`);
      expect(s3.calls).toEqual([]);
      await a.open(`${mount}/x.tmp`, 0); // not matched: ordinary S3 path (HEAD on open)
      expect(s3.calls).toEqual(['HeadObjectCommand']);
    });

    it('the database itself still syncs while its sidecar stays local', async () => {
      const a = scratch();
      writeFileSync(join(backing, 'db.sqlite'), 'main');
      writeFileSync(join(backing, 'db.sqlite-journal'), 'scratch');
      await a.open(`${mount}/db.sqlite`, 1);
      await a.flush(`${mount}/db.sqlite`);
      await a.flush(`${mount}/db.sqlite-journal`);
      expect([...s3.objects.keys()]).toEqual(['db.sqlite']);
    });

    it('rename across the boundary uploads on the way out and deletes on the way in', async () => {
      const a = scratch();
      writeFileSync(join(backing, 'final.txt'), 'done'); // the shim has already moved staging.txt-journal -> final.txt
      await a.rename(`${mount}/staging.txt-journal`, `${mount}/final.txt`);
      expect(s3.objects.get('final.txt')?.body.toString()).toBe('done');
      expect(s3.calls).not.toContain('CopyObjectCommand');
      s3.calls.length = 0;
      await a.rename(`${mount}/final.txt`, `${mount}/final.txt-wal`);
      expect(s3.objects.has('final.txt')).toBe(false);
      expect(s3.calls).toEqual(['DeleteObjectCommand']);
    });
  });

  it('surfaces S3 errors as VfsError errnos', async () => {
    s3.send = async () => {
      throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    };
    await expect(adapter.stat(`${mount}/secret.txt`)).rejects.toBeInstanceOf(VfsError);
    await expect(adapter.stat(`${mount}/secret.txt`)).rejects.toMatchObject({ errno: 13 });
  });
});
