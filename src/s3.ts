import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'fs';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { VfsAdapter, VfsError } from './server';

export type S3AdapterOptions = {
  /** Bucket that backs the mountpoint. */
  bucket: string;
  /** Key prefix inside the bucket (no leading or trailing slash). Default: bucket root. */
  prefix?: string;
  /** The virtual directory the application sees (VFS_PREFIX), e.g. `/vfs`. */
  mountpoint: string;
  /** The local directory the shim redirects to (VFS_BACKING); objects are materialized here. */
  backing: string;
  client?: S3Client;
  log?: (message: string, params?: Record<string, unknown>) => void;
};

/** What the adapter knows about one key. `etag` is the version the local copy is based on. */
type Entry = {
  etag?: string;
  size?: number;
  /** false: the local file is a sparse placeholder sized from HEAD/LIST, contents not fetched yet. */
  materialized: boolean;
};

/**
 * Backs a mountpoint with an S3 bucket. Objects are materialized into the
 * backing directory when the program first opens them and written back when
 * it closes or fsyncs them; the shim's data path (read/write/mmap) stays on
 * the local file. Directory listings materialize placeholders sized from the
 * listing so `ls -l` is right without downloading anything.
 *
 * Write-back is conditional: a flush carries `If-Match` with the ETag the
 * local copy was based on (or `If-None-Match: *` when the object did not
 * exist), so a concurrent writer makes the close fail with ESTALE instead of
 * being silently overwritten. Last writer wins only when it saw the latest.
 */
export class S3Adapter implements VfsAdapter {
  private readonly client: S3Client;
  private readonly entries = new Map<string, Entry>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly log: (message: string, params?: Record<string, unknown>) => void;

  constructor(private readonly options: S3AdapterOptions) {
    this.client = options.client ?? new S3Client({});
    this.log = options.log ?? (() => {});
    mkdirSync(options.backing, { recursive: true });
  }

  /** Path relative to the mountpoint without a leading slash ('' for the root), or undefined if outside it. */
  private rel(path: string): string | undefined {
    const { mountpoint } = this.options;
    if (path === mountpoint) {
      return '';
    }
    if (!path.startsWith(`${mountpoint}/`)) {
      return undefined;
    }
    return path.slice(mountpoint.length + 1).replace(/\/+$/, '');
  }

  private key(rel: string): string {
    const { prefix } = this.options;
    return prefix ? (rel ? `${prefix}/${rel}` : prefix) : rel;
  }

  /** Prefix for listing the children of `rel` (always ends with '/' unless it is the bucket root). */
  private dirPrefix(rel: string): string {
    const key = this.key(rel);
    return key ? `${key}/` : '';
  }

  private local(rel: string): string {
    return join(this.options.backing, rel);
  }

  /** Runs `fn` after any in-flight operation on the same key. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.chains.set(key, next);
    // Observe both outcomes: a bare .finally() would fork a second chain that rejects unhandled.
    const cleanup = (): void => {
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  }

  private async head(key: string): Promise<{ etag?: string; size?: number } | undefined> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return { etag: out.ETag, size: out.ContentLength };
    } catch (e) {
      if (isNotFound(e)) {
        return undefined;
      }
      throw toVfsError(e);
    }
  }

  private async isDir(rel: string): Promise<boolean> {
    try {
      const out = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: this.dirPrefix(rel), MaxKeys: 1 })
      );
      return (out.KeyCount ?? 0) > 0;
    } catch (e) {
      throw toVfsError(e);
    }
  }

  /** A zero-filled file of the right size, so stat() is correct before the first open(). */
  private async placeholder(rel: string, key: string, etag?: string, size?: number): Promise<void> {
    const local = this.local(rel);
    const existing = this.entries.get(key);
    if (existsSync(local) && existing?.materialized !== false) {
      return; // real local content (fetched or written here) takes precedence
    }
    await fs.mkdir(dirname(local), { recursive: true });
    const handle = await fs.open(local, 'w');
    try {
      await handle.truncate(size ?? 0);
    } finally {
      await handle.close();
    }
    this.entries.set(key, { etag, size, materialized: false });
  }

  async stat(path: string): Promise<void> {
    const rel = this.rel(path);
    if (rel === undefined) {
      return;
    }
    if (rel === '') {
      await fs.mkdir(this.options.backing, { recursive: true });
      return;
    }
    if (existsSync(this.local(rel))) {
      return;
    }
    const key = this.key(rel);
    await this.serial(key, async () => {
      const head = await this.head(key);
      if (head) {
        await this.placeholder(rel, key, head.etag, head.size);
        return;
      }
      if (await this.isDir(rel)) {
        await fs.mkdir(this.local(rel), { recursive: true });
        return;
      }
      throw VfsError.code('ENOENT', `${path}: no such object`);
    });
  }

  async fetch(path: string): Promise<void> {
    const rel = this.rel(path);
    if (rel === undefined || rel === '') {
      return;
    }
    const key = this.key(rel);
    const local = this.local(rel);
    await this.serial(key, async () => {
      const entry = this.entries.get(key);
      if (existsSync(local) && entry?.materialized !== false) {
        return; // local content is current (fetched earlier, or written here)
      }
      let out;
      try {
        out = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
      } catch (e) {
        if (isNotFound(e)) {
          if (entry?.materialized === false) {
            await fs.rm(local, { force: true }); // stale placeholder
            this.entries.delete(key);
          }
          throw VfsError.code('ENOENT', `${path}: no such object`);
        }
        throw toVfsError(e);
      }
      await fs.mkdir(dirname(local), { recursive: true });
      const tmp = `${local}.rowdy-vfs-${process.pid}.tmp`;
      try {
        await pipeline(out.Body as Readable, createWriteStream(tmp));
        await fs.rename(tmp, local);
      } finally {
        await fs.rm(tmp, { force: true });
      }
      this.entries.set(key, { etag: out.ETag, size: out.ContentLength, materialized: true });
      this.log(`fetched`, { key, size: out.ContentLength });
    });
  }

  async list(path: string): Promise<void> {
    const rel = this.rel(path);
    if (rel === undefined) {
      return;
    }
    const dir = this.local(rel);
    await fs.mkdir(dir, { recursive: true });
    const prefix = this.dirPrefix(rel);
    let token: string | undefined;
    do {
      let out;
      try {
        out = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.options.bucket,
            Prefix: prefix,
            Delimiter: '/',
            ContinuationToken: token,
          })
        );
      } catch (e) {
        throw toVfsError(e);
      }
      for (const common of out.CommonPrefixes ?? []) {
        if (common.Prefix) {
          await fs.mkdir(join(this.options.backing, this.unkey(common.Prefix)), { recursive: true });
        }
      }
      for (const object of out.Contents ?? []) {
        if (!object.Key || object.Key === prefix || object.Key.endsWith('/')) {
          continue; // directory markers
        }
        const childRel = this.unkey(object.Key);
        await this.serial(object.Key, () => this.placeholder(childRel, object.Key!, object.ETag, object.Size));
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  /** Inverse of key(): bucket key -> path relative to the mountpoint. */
  private unkey(key: string): string {
    const { prefix } = this.options;
    const rel = prefix ? key.slice(prefix.length + 1) : key;
    return rel.replace(/\/+$/, '');
  }

  async open(path: string, _flags: number): Promise<void> {
    const rel = this.rel(path);
    if (rel === undefined || rel === '') {
      return;
    }
    const key = this.key(rel);
    await this.serial(key, async () => {
      // Record the version this write is based on. A placeholder or a fetched copy already
      // carries it; a brand-new local file needs a HEAD to learn whether the object exists.
      const entry = this.entries.get(key);
      if (!entry) {
        const head = await this.head(key);
        this.entries.set(key, { etag: head?.etag, size: head?.size, materialized: true });
      } else {
        this.entries.set(key, { ...entry, materialized: true });
      }
    });
  }

  async flush(path: string): Promise<void> {
    const rel = this.rel(path);
    if (rel === undefined || rel === '') {
      return;
    }
    const key = this.key(rel);
    await this.serial(key, () => this.put(key, this.local(rel), path));
  }

  /** Conditional PutObject of the local file. Caller holds the per-key lock. */
  private async put(key: string, local: string, path: string): Promise<void> {
    let size: number;
    try {
      const st = statSync(local);
      if (st.isDirectory()) {
        return;
      }
      size = st.size;
    } catch {
      return; // removed before the flush reached us; unlink will follow
    }
    const base = this.entries.get(key)?.etag;
    const body = createReadStream(local);
    body.on('error', () => {}); // the SDK consumes read errors; a destroyed stream must not throw
    try {
      const out = await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: body,
          ContentLength: size,
          ...(base ? { IfMatch: base } : { IfNoneMatch: '*' }),
        })
      );
      this.entries.set(key, { etag: out.ETag, size, materialized: true });
      this.log(`flushed`, { key, size, base });
    } catch (e) {
      body.destroy();
      if (isPreconditionFailed(e)) {
        throw VfsError.code(
          'ESTALE',
          `${path}: object changed in S3 since it was opened (expected ETag ${base ?? 'none'})`
        );
      }
      throw toVfsError(e);
    }
  }

  async mkdir(): Promise<void> {
    // S3 has no directories; one appears as soon as an object is flushed under it.
  }

  async unlink(path: string): Promise<void> {
    const rel = this.rel(path);
    if (rel === undefined || rel === '') {
      return;
    }
    const key = this.key(rel);
    await this.serial(key, async () => {
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
      } catch (e) {
        if (!isNotFound(e)) {
          throw toVfsError(e);
        }
      }
      this.entries.delete(key);
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const relFrom = this.rel(from);
    const relTo = this.rel(to);
    if (relFrom === undefined || relTo === undefined || relFrom === '' || relTo === '') {
      throw VfsError.code('EXDEV', `${from} -> ${to}: rename across the mountpoint boundary`);
    }
    const target = this.local(relTo);
    if (existsSync(target) && statSync(target).isDirectory()) {
      // The local rename already moved the tree; move every object under the old prefix.
      const oldPrefix = this.dirPrefix(relFrom);
      let token: string | undefined;
      do {
        const out = await this.client
          .send(new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: oldPrefix, ContinuationToken: token }))
          .catch((e) => {
            throw toVfsError(e);
          });
        for (const object of out.Contents ?? []) {
          if (!object.Key) {
            continue;
          }
          const newKey = this.key(join(relTo, object.Key.slice(oldPrefix.length)));
          await this.move(object.Key, newKey);
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return;
    }
    await this.move(this.key(relFrom), this.key(relTo), relTo);
  }

  /** Server-side copy then delete. A source that was never flushed is uploaded from the local copy instead. */
  private async move(fromKey: string, toKey: string, relTo?: string): Promise<void> {
    await this.serial(toKey, async () => {
      try {
        const out = await this.client.send(
          new CopyObjectCommand({
            Bucket: this.options.bucket,
            Key: toKey,
            CopySource: `${this.options.bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
          })
        );
        this.entries.set(toKey, { etag: out.CopyObjectResult?.ETag, materialized: true });
      } catch (e) {
        if (!isNotFound(e)) {
          throw toVfsError(e);
        }
        if (relTo !== undefined) {
          this.entries.delete(toKey);
          await this.put(toKey, this.local(relTo), `${this.options.mountpoint}/${relTo}`);
        }
      }
    });
    await this.serial(fromKey, async () => {
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: fromKey }));
      } catch (e) {
        if (!isNotFound(e)) {
          throw toVfsError(e);
        }
      }
      this.entries.delete(fromKey);
    });
  }
}

type S3Error = { name?: string; $metadata?: { httpStatusCode?: number } };

const isNotFound = (e: unknown): boolean => {
  const err = e as S3Error;
  return err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey';
};

const isPreconditionFailed = (e: unknown): boolean => {
  const err = e as S3Error;
  return err?.$metadata?.httpStatusCode === 412 || err?.name === 'PreconditionFailed';
};

const toVfsError = (e: unknown): VfsError => {
  if (e instanceof VfsError) {
    return e;
  }
  const err = e as S3Error & { message?: string };
  const status = err?.$metadata?.httpStatusCode;
  if (status === 403 || err?.name === 'AccessDenied') {
    return VfsError.code('EACCES', err.message);
  }
  if (isNotFound(e)) {
    return VfsError.code('ENOENT', err.message);
  }
  return VfsError.code('EIO', err?.message ?? String(e));
};
