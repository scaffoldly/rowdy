import { createServer, Server, Socket } from 'net';
import { constants } from 'os';
import { mkdirSync, rmSync } from 'fs';
import { dirname } from 'path';

/** Where rowdy listens for the shim; see DISCLOSURE for the protocol. */
export const VFS_SOCKET = '/tmp/rowdy/vfs.sock';

/**
 * What a backing store must provide. Every method is called with virtual paths
 * (under VFS_PREFIX) and is expected to make the corresponding path under
 * VFS_BACKING correct before returning: file contents are exchanged through
 * the backing directory, never through the socket.
 *
 * Throw a VfsError (or any error with an errno/code) to fail the caller's libc
 * call with that errno.
 */
export interface VfsAdapter {
  /** Before stat/access/open: make metadata for `path` present (or throw ENOENT). */
  stat(path: string): Promise<void>;
  /** Before open for reading: make the contents of `path` present. */
  fetch(path: string): Promise<void>;
  /** Before opendir/scandir: make the entries of directory `path` present. */
  list(path: string): Promise<void>;
  /** After open for writing (`flags` are open(2) flags). */
  open(path: string, flags: number): Promise<void>;
  /** After close/fsync of a written file: persist it. */
  flush(path: string): Promise<void>;
  /** After mkdir. */
  mkdir(path: string): Promise<void>;
  /** After unlink/rmdir. */
  unlink(path: string): Promise<void>;
  /** After rename. */
  rename(from: string, to: string): Promise<void>;
  /** Before a read under a lock (SQLite SHARED): make the local copy current. Optional. */
  revalidate?(path: string): Promise<void>;
  /** Before a write under a lock (SQLite RESERVED/EXCLUSIVE): take the lease, or throw EAGAIN. Optional. */
  lock?(path: string): Promise<void>;
  /** After the write lock is dropped (and the flush is done): release the lease. Optional. */
  unlock?(path: string): Promise<void>;
}

/**
 * Linux errno values. The shim runs in a Linux (musl) child, so replies must
 * use Linux numbers even when rowdy itself runs on a macOS laptop in tests,
 * where os.constants.errno differs (ESTALE is 70 there, 116 on Linux).
 */
export const LINUX_ERRNO = {
  EPERM: 1,
  ENOENT: 2,
  EIO: 5,
  EBADF: 9,
  EAGAIN: 11,
  EACCES: 13,
  EEXIST: 17,
  EXDEV: 18,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENOSPC: 28,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ENOTSUP: 95,
  ESTALE: 116,
} as const;

export type ErrnoCode = keyof typeof LINUX_ERRNO;

/** An error carrying the errno the shim should surface. */
export class VfsError extends Error {
  constructor(
    public readonly errno: number,
    message?: string
  ) {
    super(message ?? `errno ${errno}`);
    this.name = 'VfsError';
  }

  /** From a code name such as "ENOENT". */
  static code(code: ErrnoCode, message?: string): VfsError {
    return new VfsError(LINUX_ERRNO[code], message ?? code);
  }
}

/** The errno to report for any thrown value. */
export const errnoOf = (e: unknown): number => {
  if (e instanceof VfsError) {
    return e.errno;
  }
  const err = e as { errno?: number; code?: string };
  // Prefer the code name: node's numeric errno is the host's, the name is portable.
  if (typeof err?.code === 'string' && err.code in LINUX_ERRNO) {
    return LINUX_ERRNO[err.code as ErrnoCode];
  }
  if (typeof err?.code === 'string' && err.code in constants.errno) {
    return constants.errno[err.code as keyof typeof constants.errno];
  }
  if (typeof err?.errno === 'number' && err.errno !== 0) {
    return Math.abs(err.errno); // node reports negative errnos
  }
  return LINUX_ERRNO.EIO;
};

/**
 * The backing directory is the whole store: nothing to populate or persist.
 * This is the behaviour of the shim without a socket, kept as the baseline
 * adapter and for tests.
 */
export class LocalAdapter implements VfsAdapter {
  async stat(): Promise<void> {}
  async fetch(): Promise<void> {}
  async list(): Promise<void> {}
  async open(): Promise<void> {}
  async flush(): Promise<void> {}
  async mkdir(): Promise<void> {}
  async unlink(): Promise<void> {}
  async rename(): Promise<void> {}
}

/** A mountpoint (the virtual directory the application sees) and the adapter behind it. */
export type VfsMount = { mountpoint: string; adapter: VfsAdapter };

/**
 * Several mounts behind one supervisor: each operation goes to the adapter of the mount its path
 * falls in, the longest mountpoint winning so a mount nested in another owns its own subtree.
 */
export class MountAdapter implements VfsAdapter {
  private readonly mounts: VfsMount[];

  constructor(mounts: VfsMount[]) {
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
    this.mounts = [...mounts].sort((a, b) => b.mountpoint.length - a.mountpoint.length);
  }

  /** The adapters, most specific mountpoint first. */
  get adapters(): VfsAdapter[] {
    return this.mounts.map((m) => m.adapter);
  }

  /** The mount `path` falls in, or undefined when it is under none. */
  mountOf(path: string): VfsMount | undefined {
    return this.mounts.find(({ mountpoint }) => path === mountpoint || path.startsWith(`${mountpoint}/`));
  }

  private at(path: string): VfsAdapter | undefined {
    return this.mountOf(path)?.adapter;
  }

  async stat(path: string): Promise<void> {
    await this.at(path)?.stat(path);
  }
  async fetch(path: string): Promise<void> {
    await this.at(path)?.fetch(path);
  }
  async list(path: string): Promise<void> {
    await this.at(path)?.list(path);
  }
  async open(path: string, flags: number): Promise<void> {
    await this.at(path)?.open(path, flags);
  }
  async flush(path: string): Promise<void> {
    await this.at(path)?.flush(path);
  }
  async mkdir(path: string): Promise<void> {
    await this.at(path)?.mkdir(path);
  }
  async unlink(path: string): Promise<void> {
    await this.at(path)?.unlink(path);
  }
  async revalidate(path: string): Promise<void> {
    await this.at(path)?.revalidate?.(path);
  }
  async lock(path: string): Promise<void> {
    await this.at(path)?.lock?.(path);
  }
  async unlock(path: string): Promise<void> {
    await this.at(path)?.unlock?.(path);
  }

  // Each store only knows its own objects, so a rename is within one mount or it is EXDEV,
  // which is also what the kernel answers across filesystems: callers fall back to copy+delete.
  async rename(from: string, to: string): Promise<void> {
    const source = this.mountOf(from);
    const target = this.mountOf(to);
    if (source !== target) {
      throw VfsError.code('EXDEV', `${from} -> ${to}: rename across mounts`);
    }
    await source?.adapter.rename(from, to);
  }
}

export type VfsRequest =
  | { op: 'stat' | 'fetch' | 'list' | 'flush' | 'mkdir' | 'unlink' | 'revalidate' | 'lock' | 'unlock'; path: string }
  | { op: 'open'; path: string; flags: number }
  | { op: 'rename'; from: string; to: string };

export type VfsReply = { ok: true } | { ok: false; errno: number };

export type VfsServerOptions = {
  /** Unix-domain socket path. Default VFS_SOCKET. */
  socket?: string;
  /** Called for each request after it is answered. */
  onRequest?: (request: VfsRequest, reply: VfsReply) => void;
  /** Called for adapter failures; the shim still gets its errno. */
  onError?: (request: VfsRequest, error: unknown) => void;
};

/**
 * Serves the shim's supervisor socket, dispatching each request to an adapter.
 * One request per line; replies in order per connection.
 */
export class VfsServer {
  private server?: Server;
  readonly socket: string;

  constructor(
    private readonly adapter: VfsAdapter,
    private readonly options: VfsServerOptions = {}
  ) {
    this.socket = options.socket ?? VFS_SOCKET;
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  async listen(): Promise<this> {
    if (this.server) {
      return this;
    }
    mkdirSync(dirname(this.socket), { recursive: true });
    rmSync(this.socket, { force: true }); // stale socket from a previous process
    const server = createServer((conn) => this.serve(conn));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    return this;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(this.socket, { force: true });
  }

  private serve(conn: Socket): void {
    let buffer = '';
    let queue: Promise<void> = Promise.resolve();
    conn.setEncoding('utf8');
    conn.on('error', () => conn.destroy());
    conn.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        // Replies must come back in request order on this connection.
        queue = queue.then(async () => {
          const reply = await this.handle(line);
          if (!conn.destroyed) {
            conn.write(`${JSON.stringify(reply)}\n`);
          }
        });
      }
    });
  }

  private async handle(line: string): Promise<VfsReply> {
    let request: VfsRequest;
    try {
      request = JSON.parse(line) as VfsRequest;
    } catch {
      return { ok: false, errno: LINUX_ERRNO.EINVAL };
    }
    const reply = await this.dispatch(request);
    this.options.onRequest?.(request, reply);
    return reply;
  }

  private async dispatch(request: VfsRequest): Promise<VfsReply> {
    try {
      switch (request.op) {
        case 'stat':
        case 'fetch':
        case 'list':
        case 'flush':
        case 'mkdir':
        case 'unlink':
          if (typeof request.path !== 'string') {
            return { ok: false, errno: LINUX_ERRNO.EINVAL };
          }
          await this.adapter[request.op](request.path);
          return { ok: true };
        case 'revalidate':
        case 'lock':
        case 'unlock':
          if (typeof request.path !== 'string') {
            return { ok: false, errno: LINUX_ERRNO.EINVAL };
          }
          // Adapters without leases (LocalAdapter) simply have nothing to do.
          await this.adapter[request.op]?.(request.path);
          return { ok: true };
        case 'open':
          if (typeof request.path !== 'string') {
            return { ok: false, errno: LINUX_ERRNO.EINVAL };
          }
          await this.adapter.open(request.path, Number(request.flags) || 0);
          return { ok: true };
        case 'rename':
          if (typeof request.from !== 'string' || typeof request.to !== 'string') {
            return { ok: false, errno: LINUX_ERRNO.EINVAL };
          }
          await this.adapter.rename(request.from, request.to);
          return { ok: true };
        default:
          return { ok: false, errno: LINUX_ERRNO.ENOSYS };
      }
    } catch (e) {
      this.options.onError?.(request, e);
      return { ok: false, errno: errnoOf(e) };
    }
  }
}
