import { constants } from 'os';

/** Where rowdy listens for the shim: a 9P2000.L server (see ./p9 and DISCLOSURE). */
export const VFS_SOCKET = '/tmp/rowdy/vfs.sock';

/**
 * What a backing store must provide. Every method is called with the virtual
 * path (under the mountpoint) and is expected to make the corresponding path in
 * the backing directory correct before returning: file contents are exchanged
 * through the backing directory, never through the socket. The 9P server calls
 * these around each operation; see P9Server for which message runs which hook.
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
