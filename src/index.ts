import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import packageJson from '../package.json';
import x64 from '../lib/linux-x64/vfspreload.so';
import arm64 from '../lib/linux-arm64/vfspreload.so';

// The shims ship twice: inlined here (so a pkg snapshot carries them and
// materialize() needs nothing on disk) and as files under lib/ for consumers
// that want to COPY one into an image.
const shims: Record<string, Uint8Array | undefined> = {
  'linux-x64': x64,
  'linux-arm64': arm64,
};

const VERSION = packageJson.version;
const NAME = packageJson.name;

const id = (): string => {
  return `${NAME}@${VERSION}`;
};

/** Where the shim is written for the child to preload. */
export const VFS_PRELOAD = '/tmp/rowdy/vfspreload.so';
export const VFS_PREFIX = '/vfs';
export const VFS_BACKING = '/tmp/vfsstore';

export type VfsEnv = Record<
  'ROWDY_VFS' | 'LD_PRELOAD' | 'VFS_PREFIX' | 'VFS_BACKING' | 'VFS_SOCKET' | 'VFS_MOUNTS',
  string | undefined
>;

/** A virtual prefix the app sees and the real directory that backs it. */
export type VfsMountPoint = { prefix: string; backing: string };

export type VfsConfig = {
  /** Path of the materialized shim, first entry of LD_PRELOAD. */
  preload: string;
  /** Virtual prefix the app sees. */
  prefix: string;
  /** Real directory backing the prefix. */
  backing: string;
  /** Supervisor socket the shim reports to, if any. */
  socket?: string;
  /** Every mount; `prefix`/`backing` above are the first of them. */
  mounts: VfsMountPoint[];
};

/** The compiled shim for an architecture (`linux-x64`, `linux-arm64`), or undefined if not built in. */
export const shim = (arch: string = process.arch): Buffer | undefined => {
  const data = shims[`linux-${arch}`];
  return data ? Buffer.from(data) : undefined;
};

/**
 * On-disk path of the shim shipped in this package (`lib/linux-<arch>/vfspreload.so`),
 * or undefined when it is not present as a file (e.g. inside a pkg snapshot).
 * Prefer `materialize()` at runtime; this is for build steps that copy the file.
 */
export const shimFile = (arch: string = process.arch): string | undefined => {
  const path = join(__dirname, '..', 'lib', `linux-${arch}`, 'vfspreload.so');
  return existsSync(path) ? path : undefined;
};

/**
 * Write the shim for the running architecture to `path` so a child process can
 * LD_PRELOAD it. Idempotent: an existing file with identical contents is left
 * alone. Throws if no shim is built in for the architecture.
 */
export const materialize = (path: string = VFS_PRELOAD, arch: string = process.arch): string => {
  const data = shim(arch);
  if (!data) {
    throw new Error(`${id()}: no vfspreload shim for linux-${arch}`);
  }
  if (existsSync(path) && readFileSync(path).equals(data)) {
    return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data, { mode: 0o755 });
  return path;
};

export type ApplyVfsOptions = {
  /** Where to write the shim. Default VFS_PRELOAD. */
  preload?: string;
  /** Supervisor socket the shim should talk to (a listening P9Server). Unset: local overlay only. */
  socket?: string;
  /**
   * The mounts. Default: one, `VFS_PREFIX` on `VFS_BACKING` (from `env` or the defaults). Backing
   * directories must not nest inside one another. The first is also written to `VFS_PREFIX` /
   * `VFS_BACKING`; the shim reads `VFS_MOUNTS`.
   */
  mounts?: VfsMountPoint[];
};

// VFS_MOUNTS is "prefix=backing" entries joined by ':', split by the shim at the last '='.
const encodeMounts = (mounts: VfsMountPoint[]): string => {
  for (const { prefix, backing } of mounts) {
    if (!prefix.startsWith('/') || prefix === '/' || prefix.endsWith('/') || prefix.includes(':')) {
      throw new Error(`${id()}: invalid mount prefix '${prefix}'`);
    }
    if (!backing.startsWith('/') || backing.endsWith('/') || /[:=]/.test(backing)) {
      throw new Error(`${id()}: invalid backing directory '${backing}'`);
    }
    const nested = mounts.find((other) => other.backing !== backing && other.backing.startsWith(`${backing}/`));
    if (nested) {
      throw new Error(`${id()}: backing directory '${nested.backing}' is inside '${backing}'`);
    }
  }
  return mounts.map(({ prefix, backing }) => `${prefix}=${backing}`).join(':');
};

/**
 * Opt-in userspace VFS for a child process environment. When `env.ROWDY_VFS` is
 * set, materialize the shim, prepend it to `env.LD_PRELOAD` (preserving any
 * existing value, never duplicating), default `VFS_PREFIX`/`VFS_BACKING`, and
 * point `VFS_SOCKET` at the supervisor when one is given. Mutates `env` and
 * returns the resulting config, or undefined when off.
 */
export const applyVfs = (env: VfsEnv, options: ApplyVfsOptions | string = {}): VfsConfig | undefined => {
  if (!env.ROWDY_VFS) {
    return undefined;
  }
  const opts = typeof options === 'string' ? { preload: options } : options;
  const preload = materialize(opts.preload ?? VFS_PRELOAD);
  const existing = (env.LD_PRELOAD ?? '').split(':').filter((p) => p && p !== preload);
  env.LD_PRELOAD = [preload, ...existing].join(':');
  const mounts = opts.mounts?.length
    ? opts.mounts
    : [{ prefix: env.VFS_PREFIX || VFS_PREFIX, backing: env.VFS_BACKING || VFS_BACKING }];
  env.VFS_MOUNTS = encodeMounts(mounts);
  env.VFS_PREFIX = mounts[0]!.prefix;
  env.VFS_BACKING = mounts[0]!.backing;
  if (opts.socket) {
    env.VFS_SOCKET = opts.socket;
  }
  return { preload, prefix: env.VFS_PREFIX, backing: env.VFS_BACKING, socket: env.VFS_SOCKET, mounts };
};

export * from './server';
export * from './s3';
export * from './p9/server';
export * from './p9/client';
export * as wire from './p9/wire';

export { VERSION, NAME, id };
