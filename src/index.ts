import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import packageJson from '../package.json';
import { shims } from './shims';

const VERSION = packageJson.version;
const NAME = packageJson.name;

const id = (): string => {
  return `${NAME}@${VERSION}`;
};

/** Where the shim is written for the child to preload. */
export const VFS_PRELOAD = '/tmp/rowdy/vfspreload.so';
export const VFS_PREFIX = '/vfs';
export const VFS_BACKING = '/tmp/vfsstore';

export type VfsEnv = Record<'ROWDY_VFS' | 'LD_PRELOAD' | 'VFS_PREFIX' | 'VFS_BACKING', string | undefined>;

export type VfsConfig = {
  /** Path of the materialized shim, first entry of LD_PRELOAD. */
  preload: string;
  /** Virtual prefix the app sees. */
  prefix: string;
  /** Real directory backing the prefix. */
  backing: string;
};

/** The compiled shim for an architecture (`linux-x64`, `linux-arm64`), or undefined if not built in. */
export const shim = (arch: string = process.arch): Buffer | undefined => {
  const data = shims[`linux-${arch}`];
  return data ? Buffer.from(data, 'base64') : undefined;
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

/**
 * Opt-in userspace VFS for a child process environment. When `env.ROWDY_VFS` is
 * set, materialize the shim, prepend it to `env.LD_PRELOAD` (preserving any
 * existing value, never duplicating) and default `VFS_PREFIX`/`VFS_BACKING`.
 * Mutates `env` and returns the resulting config, or undefined when off.
 */
export const applyVfs = (env: VfsEnv, preloadPath: string = VFS_PRELOAD): VfsConfig | undefined => {
  if (!env.ROWDY_VFS) {
    return undefined;
  }
  const preload = materialize(preloadPath);
  const existing = (env.LD_PRELOAD ?? '').split(':').filter((p) => p && p !== preload);
  env.LD_PRELOAD = [preload, ...existing].join(':');
  env.VFS_PREFIX = env.VFS_PREFIX || VFS_PREFIX;
  env.VFS_BACKING = env.VFS_BACKING || VFS_BACKING;
  return { preload, prefix: env.VFS_PREFIX, backing: env.VFS_BACKING };
};

export { VERSION, NAME, id };
