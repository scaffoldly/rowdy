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

## Fault report

With `VFS_FAULT_REPORT=1`, a process that dies of a SIGSEGV, SIGBUS, SIGILL or SIGFPE writes what it
was doing to its stderr before it dies (with the same status, 139 for SIGSEGV), which rowdy relays
into its log:

```
rowdy-vfs: fatal SIGSEGV (signal 11, code 1 SEGV_MAPERR) at 0x0, pid 7, tid 42, shim 53b947a
rowdy-vfs: pc 0x7f12…  r-xp /usr/local/bin/node+0x1a2b3c
rowdy-vfs: sp 0x7f34…  rw-p [anonymous] 0x7f30…-0x7f38…
rowdy-vfs: regs rax=0x0 rbx=0x7f… rcx=… rdx=… rsi=… rdi=…
rowdy-vfs: code 0x7f12…: 48 89 e5 [8b] 07 c3 …
rowdy-vfs: inside openat("/oauth/codes/abc") (depth 1), waiting on 9P Twalk
rowdy-vfs: thread 57: inside stat("/oauth/codes") (depth 1), waiting on 9P Twalk
rowdy-vfs: threads 12 registered, 1 others inside a hook or waiting on 9P
rowdy-vfs: frame 1 0x7f56…  r-xp /lib/ld-musl-x86_64.so.1+0x5c1e0
rowdy-vfs: stack sp+0x28 0x7f78…  r-xp /usr/local/bin/node+0x9f00
```

- The first line names the shim's own commit, so offsets map to an exact `vfspreload.so`.
- With `VFS_FAULT_FILE` set, the same report is also appended to that file, from every process of
  the tree that crashes, so the launcher reads it whole instead of picking it out of stderr. rowdy
  sets it alongside `VFS_FAULT_REPORT=1` and logs the file when the command exits.
- `pc` names the object the fault happened in: the shim (`vfspreload.so`), libc, the program, or
  `[anonymous]` (JIT code). A stack pointer in a guard page is reported as a stack overflow.
- `regs` is every general register (on x86_64 also the page-fault error code and trap number), and
  `code` the bytes around `pc` with `pc`'s bracketed, for disassembly.
- `inside …` is the hooked libc call the faulting thread was in, with its path and the 9P request it
  was waiting on; `not in a hook` means the fault happened outside the shim's code. `thread N:` lines
  are every other thread that was inside a hook or waiting on 9P at that moment.
- `frame` lines follow frame pointers, and stop where code has none (musl, much of node). `stack`
  lines are every word in the 16 KiB above `sp` that points into executable memory: the return
  addresses frame pointers would have given, among stale ones.
- WebAssembly memory traps (node), a signal sent with `kill`, and faults in a program with its own
  handler other than node's SIGSEGV one (which may recover, like a JVM's null checks or OpenSSL's
  SIGILL probe of CPU features) are not reported.

To do this the shim keeps its own handler for those signals first (the program's is called from it)
and gives each thread an alternate signal stack. It is off unless `VFS_FAULT_REPORT=1`, which rowdy
sets when its log level is `debug` or `trace` (an explicit `VFS_FAULT_REPORT` wins either way). Off,
nothing is installed: the `sigaction`, `signal` and `pthread_create` wrappers pass straight to libc.

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
yarn test:unit      # unit tests for the shim's headers (cmocka, ASan + UBSan) on Debian 12
yarn test:native    # tests/native/test/*.bats (bats-core): the host-arch shim under busybox, node and C callers, on alpine and debian
yarn build          # bundles src/ with lib/linux-*/vfspreload.so inlined
yarn test
yarn test:nodefs    # node's own fs/promises tests on a docker volume (jest + testcontainers, tests/native/nodefs)
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
  concurrent writer fails the close with `ESTALE` instead of being overwritten. The exception is a
  rewrite with `O_TRUNC` (`fs.writeFile`), no lock held, of a file this instance has not read since
  it last uploaded it: nothing in it came from the version it replaces, so it is last writer wins,
  like a plain create. A rewrite after a read (read-modify-write) keeps `ESTALE`. `unlink` deletes,
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
  is what makes SQLite transactions serialize across machines without WAL. A read lock trusts the
  last ETag check for `revalidateDebounceMs` (default 250 ms), so a burst of read transactions costs
  one HEAD; the write lock always re-checks, so a write never builds on a stale copy. `lockOnOpen: true`
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
