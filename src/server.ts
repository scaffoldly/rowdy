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
}

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
  static code(code: keyof typeof constants.errno, message?: string): VfsError {
    return new VfsError(constants.errno[code], message ?? code);
  }
}

/** The errno to report for any thrown value. */
export const errnoOf = (e: unknown): number => {
  const err = e as { errno?: number; code?: string };
  if (typeof err?.errno === 'number' && err.errno !== 0) {
    return Math.abs(err.errno); // node reports negative errnos
  }
  if (typeof err?.code === 'string' && err.code in constants.errno) {
    return constants.errno[err.code as keyof typeof constants.errno];
  }
  return constants.errno.EIO;
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

export type VfsRequest =
  | { op: 'stat' | 'fetch' | 'list' | 'flush' | 'mkdir' | 'unlink'; path: string }
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
      return { ok: false, errno: constants.errno.EINVAL };
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
            return { ok: false, errno: constants.errno.EINVAL };
          }
          await this.adapter[request.op](request.path);
          return { ok: true };
        case 'open':
          if (typeof request.path !== 'string') {
            return { ok: false, errno: constants.errno.EINVAL };
          }
          await this.adapter.open(request.path, Number(request.flags) || 0);
          return { ok: true };
        case 'rename':
          if (typeof request.from !== 'string' || typeof request.to !== 'string') {
            return { ok: false, errno: constants.errno.EINVAL };
          }
          await this.adapter.rename(request.from, request.to);
          return { ok: true };
        default:
          return { ok: false, errno: constants.errno.ENOSYS };
      }
    } catch (e) {
      this.options.onError?.(request, e);
      return { ok: false, errno: errnoOf(e) };
    }
  }
}
