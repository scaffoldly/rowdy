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
import { randomUUID } from 'crypto';
import { LINUX_ERRNO, VfsAdapter, VfsError } from './server';

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
  /**
   * How long a local copy is trusted before a HEAD re-checks the object's ETag
   * (ms). Keeps stat-heavy callers from turning into HEAD storms. Default 2000.
   */
  revalidateMs?: number;
  /** Lease time-to-live (ms); renewed at half-life while held. Default 30000. */
  leaseMs?: number;
  /** How long a contended lock waits before EAGAIN (ms). Default 5000. */
  lockWaitMs?: number;
  /** Take a lease on open-for-write and release it after the flush on close. Default false. */
  lockOnOpen?: boolean;
  /** Identifies this supervisor in lease objects. Default: a random id per process. */
  owner?: string;
};

/** What the adapter knows about one key. `etag` is the version the local copy is based on. */
type Entry = {
  etag?: string;
  size?: number;
  /** false: the local file is a sparse placeholder sized from HEAD/LIST, contents not fetched yet. */
  materialized: boolean;
  /** Opened for writing and not flushed yet: never overwritten by revalidation. */
  dirty?: boolean;
  /** When the remote ETag was last compared (ms since epoch). */
  checkedAt?: number;
  /** Local mtime/size at the last successful upload: an unchanged file is not re-uploaded. */
  flushed?: { mtimeMs: number; size: number };
};

/** A lease we hold: the lock object's ETag (for a safe release) and its renewal timer. */
type Lease = { etag: string; timer: ReturnType<typeof setInterval> };
type LeaseBody = { owner: string; expiresAt: number };

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
    this.owner = options.owner ?? randomUUID();
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
    if (existing?.materialized && existing.etag !== etag && !existing.dirty) {
      existing.checkedAt = 0; // the listing says it changed: re-check on next use
    }
    if (existsSync(local) && existing?.materialized) {
      return;
    }
    await fs.mkdir(dirname(local), { recursive: true });
    const handle = await fs.open(local, 'w');
    try {
      await handle.truncate(size ?? 0);
    } finally {
      await handle.close();
    }
    this.entries.set(key, { etag, size, materialized: false, checkedAt: Date.now() });
  }

  /**
   * Streams the object into the local path IN PLACE (truncate + write, same
   * inode) so a process holding the file open sees the new bytes; SQLite's
   * change counter then invalidates its page cache. Caller holds the key lock.
   */
  private async download(key: string, local: string): Promise<{ etag?: string; size?: number }> {
    let out;
    try {
      out = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    } catch (e) {
      throw isNotFound(e) ? VfsError.code('ENOENT', `${key}: no such object`) : toVfsError(e);
    }
    await fs.mkdir(dirname(local), { recursive: true });
    await pipeline(out.Body as Readable, createWriteStream(local, { flags: 'w' }));
    this.entries.set(key, { etag: out.ETag, size: out.ContentLength, materialized: true, checkedAt: Date.now() });
    this.log(`fetched`, { key, size: out.ContentLength });
    return { etag: out.ETag, size: out.ContentLength };
  }

  /**
   * Re-check a trusted local copy against the bucket, at most once per
   * revalidateMs. Changed: refetch in place (or resize a placeholder). Gone:
   * drop the local copy so the caller sees ENOENT. Dirty copies are left alone.
   * Caller holds the key lock.
   */
  private async recheck(rel: string, key: string, force = false): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || entry.dirty) {
      return;
    }
    const ttl = this.options.revalidateMs ?? 2000;
    if (!force && entry.checkedAt !== undefined && Date.now() - entry.checkedAt < ttl) {
      return;
    }
    const local = this.local(rel);
    const head = await this.head(key);
    if (!head) {
      await fs.rm(local, { force: true });
      this.entries.delete(key);
      this.log(`gone`, { key });
      return;
    }
    if (head.etag === entry.etag) {
      entry.checkedAt = Date.now();
      return;
    }
    if (entry.materialized) {
      await this.download(key, local);
    } else {
      await fs.truncate(local, head.size ?? 0);
      this.entries.set(key, { etag: head.etag, size: head.size, materialized: false, checkedAt: Date.now() });
    }
    this.log(`revalidated`, { key, etag: head.etag });
  }

  /** Protocol op: make the local copy of `path` current before a read (bypasses the TTL). */
  async revalidate(path: string): Promise<void> {
    const rel = this.rel(path);
    if (rel === undefined || rel === '') {
      return;
    }
    const key = this.key(rel);
    await this.serial(key, () => this.recheck(rel, key, true));
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
    const key = this.key(rel);
    if (existsSync(this.local(rel))) {
      await this.serial(key, () => this.recheck(rel, key));
      if (existsSync(this.local(rel))) {
        return;
      }
      throw VfsError.code('ENOENT', `${path}: no such object`);
    }
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
        // Local content: written here (dirty, trusted) or fetched earlier (re-checked by ETag).
        await this.recheck(rel, key);
        if (existsSync(local)) {
          return;
        }
        throw VfsError.code('ENOENT', `${path}: no such object`);
      }
      try {
        await this.download(key, local);
      } catch (e) {
        if (e instanceof VfsError && e.errno === LINUX_ERRNO.ENOENT && entry?.materialized === false) {
          await fs.rm(local, { force: true }); // stale placeholder
          this.entries.delete(key);
        }
        throw e;
      }
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
        if (common.Prefix && !common.Prefix.slice(prefix.length).startsWith('.rowdy/')) {
          await fs.mkdir(join(this.options.backing, this.unkey(common.Prefix)), { recursive: true });
        }
      }
      for (const object of out.Contents ?? []) {
        if (!object.Key || object.Key === prefix || object.Key.endsWith('/')) {
          continue; // directory markers
        }
        if (object.Key.slice(prefix.length).startsWith('.rowdy/')) {
          continue; // the adapter's own lease objects
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
      if (this.options.lockOnOpen) {
        await this.acquire(key, path); // EAGAIN after lockWaitMs when someone else holds it
      }
      const entry = this.entries.get(key);
      if (!entry) {
        const head = await this.head(key);
        this.entries.set(key, { etag: head?.etag, size: head?.size, materialized: true, dirty: true });
      } else {
        this.entries.set(key, { ...entry, materialized: true, dirty: true });
      }
    });
  }

  async flush(path: string): Promise<void> {
    const rel = this.rel(path);
    if (rel === undefined || rel === '') {
      return;
    }
    const key = this.key(rel);
    await this.serial(key, async () => {
      try {
        await this.put(key, this.local(rel), path);
      } finally {
        if (this.options.lockOnOpen) {
          await this.release(key); // the open/close window is over, success or not
        }
      }
    });
  }

  /** Conditional PutObject of the local file. Caller holds the per-key lock. */
  private async put(key: string, local: string, path: string): Promise<void> {
    let size: number;
    let mtimeMs: number;
    try {
      const st = statSync(local);
      if (st.isDirectory()) {
        return;
      }
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      return; // removed before the flush reached us; unlink will follow
    }
    const current = this.entries.get(key);
    if (current?.flushed && current.flushed.mtimeMs === mtimeMs && current.flushed.size === size) {
      // Exactly this content is already uploaded (e.g. fsync at commit, then the unlock-time flush).
      this.entries.set(key, { ...current, dirty: false });
      return;
    }
    const base = current?.etag;
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
      this.entries.set(key, {
        etag: out.ETag,
        size,
        materialized: true,
        dirty: false,
        checkedAt: Date.now(),
        flushed: { mtimeMs, size },
      });
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

  /* ---- leases (ADR 0001) -------------------------------------------------
   * A lease for key K is the object <prefix>/.rowdy/locks/K holding
   * { owner, expiresAt }. Acquire = conditional create (If-None-Match: *), so
   * S3 itself is the mutex; a lease past expiresAt is taken over with If-Match
   * on its ETag so two takers cannot both win. Release = delete, only by the
   * holder. Correctness never rests on the lease alone: the conditional upload
   * in put() still rejects a stale write. */

  private readonly leases = new Map<string, Lease>();
  private readonly owner: string;

  private lockKey(key: string): string {
    const { prefix } = this.options;
    return `${prefix ? `${prefix}/` : ''}.rowdy/locks/${key}`;
  }

  private async readLease(lockKey: string): Promise<{ body: LeaseBody; etag?: string } | undefined> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: lockKey }));
      const text = await (out.Body as Readable & { transformToString(): Promise<string> }).transformToString();
      return { body: JSON.parse(text) as LeaseBody, etag: out.ETag };
    } catch (e) {
      if (isNotFound(e)) {
        return undefined;
      }
      throw toVfsError(e);
    }
  }

  private async writeLease(lockKey: string, condition: Record<string, string>): Promise<string | undefined> {
    const ttl = this.options.leaseMs ?? 30000;
    const body: LeaseBody = { owner: this.owner, expiresAt: Date.now() + ttl };
    const out = await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: lockKey,
        Body: JSON.stringify(body),
        ContentType: 'application/json',
        ...condition,
      })
    );
    return out.ETag;
  }

  /** Take the lease for `key`, waiting up to lockWaitMs. Re-entrant for the holder. Caller holds the key lock. */
  private async acquire(key: string, path: string): Promise<void> {
    if (this.leases.has(key)) {
      return;
    }
    const lockKey = this.lockKey(key);
    const deadline = Date.now() + (this.options.lockWaitMs ?? 5000);
    let delay = 50;
    for (;;) {
      try {
        const etag = await this.writeLease(lockKey, { IfNoneMatch: '*' });
        this.hold(key, lockKey, etag);
        return;
      } catch (e) {
        if (!isPreconditionFailed(e)) {
          throw toVfsError(e);
        }
      }
      // Held by someone. Expired? Take it over against its exact ETag.
      const current = await this.readLease(lockKey);
      if (!current) {
        continue; // released between our attempt and the read: retry immediately
      }
      if (current.body.expiresAt < Date.now() && current.etag) {
        try {
          const etag = await this.writeLease(lockKey, { IfMatch: current.etag });
          this.log(`lease taken over`, { key, from: current.body.owner });
          this.hold(key, lockKey, etag);
          return;
        } catch (e) {
          if (!isPreconditionFailed(e)) {
            throw toVfsError(e);
          }
        }
      }
      if (Date.now() >= deadline) {
        throw VfsError.code('EAGAIN', `${path}: locked by ${current.body.owner}`);
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 1000);
    }
  }

  private hold(key: string, lockKey: string, etag?: string): void {
    const ttl = this.options.leaseMs ?? 30000;
    const timer = setInterval(
      () => {
        const lease = this.leases.get(key);
        if (!lease) {
          return;
        }
        this.writeLease(lockKey, { IfMatch: lease.etag })
          .then((next) => {
            if (next) lease.etag = next;
          })
          .catch((e) => this.log(`lease renewal failed`, { key, error: `${e}` }));
      },
      Math.max(ttl / 2, 500)
    );
    timer.unref?.();
    this.leases.set(key, { etag: etag ?? '', timer });
    this.log(`lease acquired`, { key });
  }

  /** Release the lease for `key` if we hold it. Idempotent. */
  private async release(key: string): Promise<void> {
    const lease = this.leases.get(key);
    if (!lease) {
      return;
    }
    clearInterval(lease.timer);
    this.leases.delete(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.lockKey(key) }));
    } catch (e) {
      if (!isNotFound(e)) {
        throw toVfsError(e);
      }
    }
    this.log(`lease released`, { key });
  }

  /** Protocol op: hold the lease for `path` until unlock (SQLite's write transaction). */
  async lock(path: string): Promise<void> {
    const rel = this.rel(path);
    if (rel === undefined || rel === '') {
      return;
    }
    const key = this.key(rel);
    await this.serial(key, () => this.acquire(key, path));
  }

  /** Protocol op: release the lease for `path`. */
  async unlock(path: string): Promise<void> {
    const rel = this.rel(path);
    if (rel === undefined || rel === '') {
      return;
    }
    const key = this.key(rel);
    await this.serial(key, () => this.release(key));
  }

  /** Drop every lease we hold (shutdown). */
  async releaseAll(): Promise<void> {
    await Promise.all([...this.leases.keys()].map((key) => this.release(key)));
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
