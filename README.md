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
(node) stats through `syscall(SYS_statx)` rather than the wrapper. `close`, `fsync`, `fdatasync`,
`dup*`, `fclose`, `fcntl` locks and `flock` are hooked on descriptors the shim opened so the
supervisor hears about writes and advisory-lock transitions; the real calls still run.

Each entry point is hooked on its own: libc binds its own internal cross-calls (`fopen` → `open`,
`scandir` → `opendir`), musl and glibc alike, so one wrapper never covers another. glibc programs
also reach some calls under other names: the 64-bit names (`stat64`, `fopen64`, `scandir64`, …),
the `_FORTIFY_SOURCE` entry points (`__open_2`, `__realpath_chk`, …), `renameat2`, `fcntl64`, and
the pre-2.33 `__xstat` family that binaries built against older glibc still call.

## Limits

- Dynamically linked programs that go through libc see the VFS: musl (alpine) and glibc 2.34 or
  newer (debian 12, ubuntu 22.04+, Amazon Linux 2023, distroless `nodejs`/`cc`/`base`). One object
  serves both ([ADR 0003](docs/adr/0003-one-shim-for-musl-and-glibc.md)). Older glibc (Debian 11,
  Amazon Linux 2) still starts preloaded programs and passes basic file operations, but is not
  otherwise tested. Static binaries and Go programs that issue raw syscalls do not see the VFS.
- `mmap` works through the descriptor, which already refers to the backing file: shared-mapping
  writes upload on `close` or `fsync` like `write()`. `msync` alone does not upload.
- Extended attributes are kept on the instance's backing file and are not stored in S3.
- `glob` and `nftw` paths are not translated.
- It is not a mountpoint. A process started outside the preload cannot see it.

## Development

```sh
yarn build:native   # compiles native/vfspreload.c for x64 and arm64 on Debian 12 (docker), then gates it
```

Every push to `vfs` also uploads the packed build as an asset of the rolling `vfs-builds` pre-release
(`rowdy-vfs-<sha>.tgz`), which is how rowdy pins this package: by commit, without waiting on the
registry's review of the shim. The npm release stays the reviewed, attested one for everyone else.

```sh
yarn test:native    # drives the host-arch shim through busybox, node and a C caller, on alpine and debian
yarn build          # bundles src/ with lib/linux-*/vfspreload.so inlined
yarn test
```

CI builds and tests the shim on native x64 and arm64 runners, then **stages** a `beta` pre-release
on npm (with provenance) on every push to the `vfs` branch. A maintainer promotes it:

```sh
npm stage list @scaffoldly/rowdy-vfs
npm stage approve <stage-id>   # prompts for 2FA
```

## Dual-use declaration

This package ships an `LD_PRELOAD` libc interposer, which looks like a hooking kit to automated
scanning, so it declares npm's [dual-use content policy](https://docs.npmjs.com/policies/dual-use/):
`contentPolicy.class = "dual-use"` in `package.json` plus a `DISCLOSURE` file in the tarball
describing exactly what the shim does, the local supervisor socket it may use, and what it never
does. Both must stay in every future version. Keep `DISCLOSURE` accurate when the shim's
capabilities change.

## Supervisor and adapters

Several directories can be mounted at once. Pass `mounts` to `applyVfs` and give `P9Server` one
entry per mount; a client attaches to a mount by its mountpoint and the longest mountpoint wins for
a path, so a mount nested in another owns its own subtree (a rename across mounts is `EXDEV`):

```ts
const mounts = [
  { prefix: '/s3', backing: '/tmp/vfsstore' },
  { prefix: '/scratch', backing: '/tmp/vfsstore.1' },
];
const server = await new P9Server(
  [
    {
      mountpoint: '/s3',
      backing: '/tmp/vfsstore',
      adapter: new S3Adapter({ bucket, mountpoint: '/s3', backing: '/tmp/vfsstore' }),
    },
    { mountpoint: '/scratch', backing: '/tmp/vfsstore.1', adapter: new LocalAdapter() },
  ],
  { socket: VFS_SOCKET }
).listen();
applyVfs(env, { socket: server.socket, mounts }); // sets VFS_MOUNTS
```

Backing directories must not nest inside one another.

With `VFS_SOCKET` set, the shim talks 9P2000.L to a `P9Server` over a
unix-domain socket (one JSON object per line, paths and metadata only; the protocol is in
`DISCLOSURE`). The server dispatches to a `VfsAdapter`:

- `LocalAdapter`: the backing directory is the whole store (no-ops).
- `S3Adapter({ bucket, prefix?, mountpoint, backing })`: objects are materialized into the backing
  directory on first open (`fetch`), directory listings create correctly sized placeholders without
  downloading (`list`), and files are written back on close/fsync (`flush`) with
  `PutObject If-Match: <etag the copy was based on>` (or `If-None-Match: *` for a new object), so a
  concurrent writer fails the close with `ESTALE` instead of being overwritten. `unlink` deletes,
  `rename` copies server-side then deletes (a renamed directory moves every key under it). S3 has
  no directories: `mkdir` writes a `<key>/` marker object (the S3 console's convention) so an empty
  directory exists on every instance; `rmdir` removes it.
  Credentials come from the default provider chain of the process running the server.
  Multi-writer behaviour follows [ADR 0001](docs/adr/0001-multi-writer-leases.md): a trusted local
  copy is re-checked against the object's ETag at most every `revalidateMs` (default 2 s) and
  refetched **in place** when it changed, so an open descriptor sees the new bytes; writers can be
  serialized with leases (`<prefix>/.rowdy/locks/<key>`, conditional creates, `leaseMs` TTL with
  renewal, `lockWaitMs` before `EAGAIN`). The shim turns advisory locks into lease traffic
  (`fcntl`/`flock`: read lock → `revalidate`, write lock → `lock`, unlock → `flush` + `unlock`), which
  is what makes SQLite transactions serialize across machines without WAL. `lockOnOpen: true`
  additionally holds the lease across every open-for-write/close window for plain files.

```ts
import { P9Server, S3Adapter, VFS_SOCKET, applyVfs } from '@scaffoldly/rowdy-vfs';

const adapter = new S3Adapter({ bucket: 'example-bucket', mountpoint: '/vfs', backing: '/tmp/vfsstore' });
const server = await new P9Server([{ mountpoint: '/vfs', backing: '/tmp/vfsstore', adapter }], {
  socket: VFS_SOCKET,
}).listen();
const env = { ...process.env, ROWDY_VFS: '1' };
applyVfs(env, { socket: server.socket, mounts: [{ prefix: '/vfs', backing: '/tmp/vfsstore' }] });
```

Ceilings of the S3 adapter: whole-object materialization (an object must fit on the backing disk),
and errno values are Linux's regardless of the host. Materialized copies are kept within `cacheBytes`
(default: half of the backing filesystem); past that, the least recently used copies that are not open
and have no unflushed edits become placeholders again and are fetched on next use.

Declarative `volumes:` in rowdy's Routes manifest drive all of this; see
[scaffoldly/rowdy#27](https://github.com/scaffoldly/rowdy/issues/27).
