# ADR 0003: One shim for musl and glibc

- Status: Accepted (2026-10-07)
- Scope: `@scaffoldly/rowdy-vfs` (`native/`, CI), rowdy docs, nuss-io
- Relates to: [ADR 0002](0002-handle-based-core-and-9p-control-plane.md), scaffoldly/rowdy#7

## Context

`vfspreload.so` is built with gcc on alpine and links against musl. Rowdy prepends it to the app's
`LD_PRELOAD`, so only dynamically linked musl apps see a volume. A glibc app (debian, ubuntu,
Amazon Linux 2023, distroless `nodejs`/`cc`/`base`) cannot load a musl object: glibc's loader prints
`object … cannot be preloaded: ignored` and the app gets `ENOENT` under every mountpoint, with
nothing in rowdy's logs to say why.

Probes on 2026-10-07 (throwaway builds of the current source, amd64):

- The source compiles unchanged against glibc 2.36 with `-Werror`.
- Built on Debian 12 with `-ftls-model=initial-exec -fno-stack-protector -U_FORTIFY_SOURCE`, the
  object's only `DT_NEEDED` is `libc.so.6` and its newest symbol version is `GLIBC_2.34`. Without
  `initial-exec`, thread-local storage adds `ld-linux-x86-64.so.2` (for `__tls_get_addr`).
- That **one object** passes the full busybox/node/fopen suite under musl (`node:22-alpine`): musl's
  loader treats `libc.so.6` as itself and ignores glibc symbol versions, and the structures and flags
  the shim passes through (`struct stat`, `struct flock`, `O_*`, `F_*`, `RTLD_NEXT`) follow the kernel
  ABI on x86_64 and aarch64.
- Under glibc (`node:22-bookworm-slim`) it works until a program calls a glibc entry point the shim
  does not hook: GNU `mv` calls `renameat2`, libuv's `fs.readdir` calls `scandir64`, fortified builds
  call `__open_2`. Also imported and unhooked: `fopen64`, `mkstemp64`, `statfs64`, `getxattr`.
- On musl, a preload with an unresolved symbol is **fatal**: every preloaded program refuses to
  start (`Error loading shared library …`). glibc only warns.

## Decision

Ship **one** `vfspreload.so` per architecture, built against glibc, that both libcs load.

### 1. The shim

`native/vfspreload.c` stays one file. New hooks, each a thin wrapper over an existing hook's path
translation and supervisor notification, calling the real symbol of the same name:

| Group                | Symbols                                                                                                                    | Wraps                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 64-bit names         | `stat64` `lstat64` `fstatat64` `statfs64` `statvfs64` `truncate64` `creat64` `fopen64` `freopen64` `scandir64` `mkstemp64` | the `stat`, `lstat`, `fstatat`, `statfs`, `statvfs`, `truncate`, `creat`, `fopen`, `freopen`, `scandir`, `mkstemp` hooks                                                  |
| Fortify entry points | `__open_2` `__open64_2` `__openat_2` `__openat64_2`                                                                        | the `open`/`openat` hooks, without a mode (they never create)                                                                                                             |
|                      | `__realpath_chk` `__getcwd_chk` `__readlink_chk` `__readlinkat_chk`                                                        | the existing hook, after glibc's buffer-length check (`__chk_fail` on overflow, as glibc would)                                                                           |
| Rename               | `renameat2`                                                                                                                | the `renameat` hook. `flags` 0 or `RENAME_NOREPLACE` rename and notify as usual; `RENAME_EXCHANGE` or `RENAME_WHITEOUT` on a VFS path return `EINVAL` (rename is one-way) |
| Extended attributes  | `getxattr` `lgetxattr` `setxattr` `lsetxattr` `listxattr` `llistxattr` `removexattr` `lremovexattr`                        | path translation only; attributes live on the backing file and are not carried to S3                                                                                      |
| Directory            | `scandirat` `scandirat64`                                                                                                  | the `scandir` hook, with a directory descriptor (as `fstatat` does)                                                                                                       |
| Spawn                | `posix_spawn` `posix_spawnp`                                                                                               | translate the program path; glibc's implementation execs internally, past the `execve` hook                                                                               |

Found while implementing, and added:

- **`fcntl64`.** glibc 2.28+ binds `fcntl` to `fcntl64` in programs built with
  `_FILE_OFFSET_BITS=64`. SQLite is one, so its advisory locks (the leases of
  [ADR 0001](0001-multi-writer-leases.md)) arrive there.
- **The pre-2.33 `__xstat` family** (`__xstat`, `__xstat64`, `__lxstat`, `__lxstat64`, `__fxstatat`,
  `__fxstatat64`). The 2.34 floor is the glibc an app runs on, not the one it was built against:
  official node builds target glibc 2.28 and call these, and newer glibc keeps them for such
  binaries. Without them SQLite's path `stat` bypassed the VFS (`SQLITE_IOERR_FSTAT`).

On LP64, the only targets built, the 64-bit types are the plain types, so the 64-bit names and the
`__xstat` family delegate to the plain hooks rather than resolving their own real symbols;
`_Static_assert`s pin the layouts. `scandirat` is glibc-only (musl does not provide it).

The new hooks apply to musl callers too wherever musl exports the name.

Rules for every hook:

- **Absent real symbol.** When `dlsym(RTLD_NEXT, name)` returns `NULL` (a musl process, or a name a
  libc does not export), fall back to the base function, as `open64` does today; with no base,
  return `-1` with `errno = ENOSYS`. A hook never calls through `NULL`.
- **Only shared symbols.** The shim itself calls only functions both libcs export. Section 2 enforces
  this mechanically.
- **Declarations.** The fortify entry points have no public prototypes, so the file declares them.
  `REAL()` gains a variant that takes the function type explicitly for those.

Unchanged: the 9P protocol, the supervisor, `applyVfs` (one `LD_PRELOAD` path,
`/tmp/rowdy/vfspreload.so`), and musl behaviour, which the existing suite pins.

### 2. Build and CI gates

- **Builder.** `native/build.sh` builds in `debian:12` **pinned by digest** (glibc 2.36). glibc 2.38
  headers redirect calls such as `strtol` to `__isoc23_strtol`, which musl does not export, so moving
  the pin is a deliberate change. Flags:
  `-O2 -s -shared -fPIC -Wall -Wextra -Werror -ftls-model=initial-exec -fno-stack-protector -U_FORTIFY_SOURCE`.
  Output stays `lib/linux-<arch>/vfspreload.so`.
- **Symbol gate** (`native/symbols.sh`, after every build, fails the job):
  1. `DT_NEEDED` is exactly `libc.so.6` and `libdl.so.2` (see Consequences).
  2. Every strong undefined symbol is exported by musl, checked inside alpine against
     `/lib/ld-musl-<arch>.so.1`. Weak references (`__cxa_finalize`, `_ITM_*`, `__gmon_start__`) are
     allowed.
  3. The highest `GLIBC_x.y` version required is at most `2.17`.
- **Tests.** `native/test.sh` tests the built artifact rather than compiling its own, in two images:
  - `node:22-alpine`: the current suite (busybox, node/libuv, the C `fopen` caller, several mounts,
    the supervisor socket), plus the new hooks musl exports.
  - `node:22-bookworm-slim`: the same suite with GNU coreutils in place of busybox (`mv` →
    `renameat2`), node `readdir` (`scandir64`), the C caller built with `-O2 -D_FORTIFY_SOURCE=2`
    (`__open_2`, `__realpath_chk`, `__getcwd_chk`, `__readlink_chk`), and a C caller for the `xattr`
    family, `scandirat` and `posix_spawn`.
- **CI** (`vfs.yml` → `native`, per architecture on `ubuntu-24.04` and `ubuntu-24.04-arm`): build →
  symbol gate → alpine suite → debian suite → upload. `native/conformance.sh` (the kernel's v9fs
  against the 9P server) is libc-independent and unchanged.

### 3. Rollout

1. rowdy-vfs: sections 1 and 2 as a PR into `vfs`, then a staged npm publish.
2. rowdy (PR on `main`): bump `@scaffoldly/rowdy-vfs`, and rewrite the limits in `docs/volumes.md`
   and the README's Volumes paragraph:
   - dynamically linked musl or glibc 2.34+ apps see volumes; static binaries cannot;
   - extended attributes stay on the instance and are not stored in S3;
   - `mmap` goes through the descriptor, so shared-mapping writes upload on `close`/`fsync` like
     `write()`; `msync` alone does not upload;
   - `glob` and `nftw` are not translated.
3. nuss-io: the runner stage moves to `gcr.io/distroless/nodejs22-debian12:nonroot`. nuss-io uses
   `node:sqlite` and has no native modules, so the build stages stay as they are. Deploy through CI
   at debug.

Done when the nuss-io deploy shows no `cannot be preloaded` warning, supervisor trace lines from the
glibc `node`, database reads and writes that survive a cold start, and the contended-write run
(100% writes, one concurrent request) behaving as it does on alpine: leases, `SQLITE_BUSY` retries,
no corruption.

## Alternatives considered

- **Two builds, selected by `$LIB`.** With `LD_PRELOAD=/tmp/rowdy/$LIB/vfspreload.so`, glibc expands
  `$LIB` (`lib/x86_64-linux-gnu`, `lib/aarch64-linux-gnu`, `lib64`) and musl reads it literally, so
  each loader opens its own build from a directory laid out per expansion. Probed and working on
  alpine, debian 12, ubuntu 24.04, Amazon Linux 2023 and distroless nodejs22. Rejected for twice the
  artifacts and toolchains, and a silent gap on any distribution whose `$LIB` is not in the list.
- **Two builds, selected by the app binary's `PT_INTERP`.** Resolve the command, follow `#!`, read
  the ELF interpreter. Rejected: detection code to maintain, and a child using a different libc than
  its parent gets the wrong object. The filesystem cannot decide it either: until scaffoldly/rowdy#81,
  rowdy's own layers put `ld-musl` into every image.
- **A glibc floor below 2.34.** 2.28 adds Debian 10/11 and Ubuntu 20.04; 2.26 adds Amazon Linux 2,
  the base of AWS's AL2 Lambda images. Not adopted as a supported floor (no test coverage beyond the
  check below), but see Consequences: those libcs must not be broken.

## Consequences

- One artifact per architecture; the npm package layout and rowdy's `applyVfs` are unchanged.
- A toolchain change that pulls in a glibc-only symbol would stop every preloaded musl app from
  starting. The digest-pinned builder and the symbol gate make that a CI failure, not a deploy
  failure.
- glibc apps from 2.34 on see volumes, including distroless `nodejs`, `cc` and `base`.
- Below the floor, a preloaded process must still start. Binding `dlsym@GLIBC_2.34` would make glibc
  older than 2.34 fail every preloaded process before `main` (`version 'GLIBC_2.34' not found`),
  where the previous musl-only object was merely ignored. So `dlsym` is bound at its original
  version and attributed to `libdl.so.2`, as in binaries built against older glibc (`build.sh` links
  a stub to record that), the `__xstat` hooks call glibc's own `__xstat*` where it exports them, and
  the symbol gate allows nothing newer than `GLIBC_2.17` (aarch64's baseline). `native/legacy.sh`
  checks Debian 11 (2.31) and Amazon Linux 2 (2.26) in CI.
- Static binaries (Go with `CGO_ENABLED=0`, distroless `static`) still cannot: there is no loader to
  preload into, and Lambda permits no kernel-mediated alternative.

## Follow-ups

- `glob`/`glob64` and `nftw`/`ftw`: glibc walks directories with internal calls, so the shim must
  rewrite the pattern or root to the backing directory, rewrite every result back, and notify a
  listing for each directory not yet fetched from S3.
- A startup warning in rowdy when the app binary is static, so a volume it cannot see is reported.
