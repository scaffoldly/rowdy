import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { S3Adapter, VfsError } from '../src';

type Stored = { body: Buffer; etag: string };

/** Enough of S3 to exercise the adapter: keys, ETags, conditional puts, prefix listing. */
class FakeS3 {
  readonly objects = new Map<string, Stored>();
  readonly calls: string[] = [];
  private version = 0;

  put(key: string, body: string): Stored {
    const stored = { body: Buffer.from(body), etag: `"v${++this.version}"` };
    this.objects.set(key, stored);
    return stored;
  }

  async send(command: unknown): Promise<unknown> {
    this.calls.push(command!.constructor.name);
    if (command instanceof HeadObjectCommand) {
      const o = this.objects.get(command.input.Key!);
      if (!o) throw notFound();
      return { ETag: o.etag, ContentLength: o.body.length };
    }
    if (command instanceof GetObjectCommand) {
      const o = this.objects.get(command.input.Key!);
      if (!o) throw notFound('NoSuchKey');
      return { ETag: o.etag, ContentLength: o.body.length, Body: Readable.from([o.body]) };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key!;
      const existing = this.objects.get(key);
      if (command.input.IfNoneMatch === '*' && existing) throw precondition();
      if (command.input.IfMatch && existing?.etag !== command.input.IfMatch) throw precondition();
      const chunks: Buffer[] = [];
      for await (const chunk of command.input.Body as Readable) chunks.push(Buffer.from(chunk));
      return { ETag: this.put(key, Buffer.concat(chunks).toString()).etag };
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

    it('fails with ESTALE when a "new" object appeared before the first flush', async () => {
      writeFileSync(join(backing, 'race.txt'), 'mine');
      await adapter.open(`${mount}/race.txt`, 0); // HEAD: nothing there
      s3.put('race.txt', 'theirs');
      await expect(adapter.flush(`${mount}/race.txt`)).rejects.toMatchObject({ errno: 116 });
    });

    it('ignores a flush for a file that is already gone', async () => {
      await expect(adapter.flush(`${mount}/vanished.txt`)).resolves.toBeUndefined();
      expect(s3.calls).toEqual([]);
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

  it('surfaces S3 errors as VfsError errnos', async () => {
    s3.send = async () => {
      throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    };
    await expect(adapter.stat(`${mount}/secret.txt`)).rejects.toBeInstanceOf(VfsError);
    await expect(adapter.stat(`${mount}/secret.txt`)).rejects.toMatchObject({ errno: 13 });
  });
});
