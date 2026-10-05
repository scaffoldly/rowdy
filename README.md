# Rowdy VFS

A userspace virtual filesystem for containers that [rowdy](https://github.com/scaffoldly/rowdy)
fronts. The app sees a writable, persistent tree at `/vfs` backed by a real directory, with no
kernel involvement: an `LD_PRELOAD` shim rewrites the libc path calls the app makes.

## Why userspace

The Lambda sandbox denies every kernel-mediated option. `/dev/fuse` is absent, and `mount(2)`,
`unshare`, `ptrace` and `seccomp(NEW_LISTENER)` all return `EPERM`. libc interposition is the one
path that survives, and rowdy, as the entrypoint supervisor, is the single place to inject it
into the whole child tree.

## Usage

```ts
import { applyVfs } from '@scaffoldly/rowdy-vfs';

const env = { ...process.env };
const vfs = applyVfs(env); // undefined unless env.ROWDY_VFS is set
// env.LD_PRELOAD   = '/tmp/rowdy/vfspreload.so' (prepended, never duplicated)
// env.VFS_PREFIX   = '/vfs'          (kept if already set)
// env.VFS_BACKING  = '/tmp/vfsstore' (kept if already set)
spawn(cmd, args, { env });
```

`applyVfs` writes the shim for the running architecture to `/tmp/rowdy/vfspreload.so` (the path
is the second argument) and returns `{ preload, prefix, backing }`. The shims for `linux-x64` and
`linux-arm64` ship twice: as files under `lib/linux-<arch>/vfspreload.so` (`shimFile()` returns
the path, for a Dockerfile `COPY`) and inlined into `dist/index.js`, so there is no native build
at install time and a `pkg`-built binary carries them in its snapshot.

## What the shim covers

The public libc path surface: `open`/`openat`/`creat`, `fopen`/`freopen`, `stat`/`lstat`/
`fstatat`/`statx`, `access`/`faccessat`, `statfs`/`statvfs`, `chmod`/`fchmodat`, `chown`/
`lchown`/`fchownat`, `truncate`, `utimensat`/`utimes`/`utime`, `opendir`/`scandir`, `mkdir`/
`mkdirat`, `rmdir`, `unlink`/`unlinkat`, `remove`, `mkfifo`/`mknod`, `rename`/`renameat`,
`link`/`linkat`, `symlink`/`symlinkat`, `mkstemp`/`mkdtemp`, `chdir`, `execve`/`execv`/`execvp`.

`getcwd`, `realpath` and `readlink` are translated in reverse so the backing directory never
leaks into the app's view. `syscall(2)` is interposed for the single-path syscalls, since libuv
(node) stats through `syscall(SYS_statx)` rather than the wrapper.

Each entry point is hooked on its own: musl binds libc-internal cross-calls (`fopen` → `open`,
`scandir` → `opendir`) internally, so one wrapper never covers another.

## Limits

- Only dynamically linked musl (alpine) binaries that go through libc see the VFS. Static
  binaries and Go programs that issue raw syscalls do not.
- `mmap` of a `/vfs` file is not translated; neither are `nftw`, `glob` or `posix_spawn` paths.
- It is not a mountpoint. A process started outside the preload cannot see it.
- Preloading the musl shim into a glibc child fails to load (ld.so warning), and the app runs
  without the VFS.

## Development

```sh
yarn build:native   # compiles native/vfspreload.c for x64 and arm64 in alpine (docker)
yarn test:native    # drives the shim through busybox, node and a C caller under LD_PRELOAD
yarn build          # bundles src/ with lib/linux-*/vfspreload.so inlined
yarn test
```

CI builds and tests the shim on native x64 and arm64 runners, then publishes a `beta` pre-release
to npm on every push to the `vfs` branch.

Pluggable backings (`s3://bucket:/path`) are tracked in
[scaffoldly/rowdy#27](https://github.com/scaffoldly/rowdy/issues/27).
