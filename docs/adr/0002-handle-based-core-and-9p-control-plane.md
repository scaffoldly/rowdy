# ADR 0002: A kernel-shaped shim and a 9P2000.L control plane

- Status: Accepted (2026-10-06, after external review)
- Scope: `@scaffoldly/rowdy-vfs` (shim, supervisor protocol, `VfsAdapter`)
- Relates to: scaffoldly/rowdy#27, [ADR 0001](0001-multi-writer-leases.md)
- Origin: external design review of the 0.1.0 betas

## Context

The 0.1.0 design is a **path-keyed notification protocol**. The shim rewrites libc path calls to a
local backing directory and tells the supervisor what it is about to do or has done (`stat`,
`fetch`, `list`, `open`, `flush`, `mkdir`, `unlink`, `rename`, later `revalidate`, `lock`,
`unlock`) as JSON lines over a unix socket. The adapter populates the backing directory before an
operation and persists it afterwards.

It works: SQLite on S3 held 64k commits across concurrent Lambda instances without a lost or
duplicated row. But review of the design made two points that the bug history supports.

**1. The layering does not match the structure the kernel already worked out, so we rediscovered
it one bug at a time.**

| Added reactively in 0.1.0                        | The slot it belongs in                        |
| ------------------------------------------------ | --------------------------------------------- |
| `revalidate` op, 2 s TTL                         | `d_revalidate`, attribute-cache timeout       |
| `lock` / `unlock` from an `fcntl` hook           | `file_operations.lock` / `.flock`             |
| ETag as "the version this copy is based on"      | inode version (`i_version`, 9P `qid.version`) |
| `g_fdwlock[]`, `fd_path()`                       | the fd table and open-file objects            |
| A single `VFS_PREFIX`                            | the mount table                               |
| mtime/size/CRC32 comparison to decide "modified" | the filesystem sees writes, so it knows       |
| `local=<glob>` special-cased in every adapter op | a pass-through mount                          |

The common cause is that state is keyed by **path**, not by **handle**. Rename, unlink-while-open
and hard links are approximations; the adapter infers what happened to a file instead of being
told; every new capability is another op threaded through ~80 hooks.

**2. The IPC is bespoke where a standard exists.** 9P2000.L is this RPC: `Twalk`, `Tgetattr`,
`Tlopen`, `Tlcreate`, `Treaddir`, `Tfsync`, `Tlock`, `Tgetlock`, `Trenameat`, `Tunlinkat`,
`Tmkdir`, `Tclunk`. It has handles (fids), carries Linux errno in `Rlerror` (we maintain a
`LINUX_ERRNO` table for that), a change counter in `qid.version`, and a lock call with a
`BLOCKED` status. It also has a client in every Linux kernel.

One property of the current design must survive: **file data never crosses the IPC**. The
application holds a real kernel descriptor on the backing file, so `read`, `pread`, `epoll`, `dup`,
`fork`, `sendfile` and descriptor passing behave natively and reads cost a local read. The Lambda
sandbox denies every kernel client (`mount`, `/dev/fuse`, namespaces), so in Lambda the client is
always the preload shim.

## Decision

1. **Layer the shim like a kernel.** Three layers with one-way dependencies:
   - _interposition_: the libc symbols, argument marshalling, nothing else;
   - _core_: a mount table (several volumes, pass-through mounts), an fd table mapping descriptors
     to open-file objects, and an attribute cache with explicit revalidation;
   - _transport_: the client for the supervisor protocol.

2. **Make the supervisor protocol 9P2000.L**, over the existing unix socket, as the **control
   plane**. Subset: `Tversion`, `Tattach`, `Twalk`, `Tgetattr`, `Tsetattr`, `Tlopen`, `Tlcreate`,
   `Treaddir`, `Tfsync`, `Tlock`, `Tgetlock`, `Trenameat`, `Tunlinkat`, `Tmkdir`, `Tclunk`,
   `Tflush`.

   | 0.1.0 op                  | 9P2000.L                                                     |
   | ------------------------- | ------------------------------------------------------------ |
   | `stat`                    | `Twalk` + `Tgetattr`                                         |
   | `fetch`, `open`           | `Tlopen` / `Tlcreate` (reply once the backing file is ready) |
   | `list`                    | `Treaddir`                                                   |
   | `flush`                   | `Tfsync`; final flush on `Tclunk`                            |
   | `revalidate`              | `Tgetattr`, compare `qid.version`                            |
   | `lock` / `unlock`         | `Tlock` (`WRLCK` / `UNLCK`), `BLOCKED` → `EAGAIN`            |
   | `mkdir`/`unlink`/`rename` | `Tmkdir` / `Tunlinkat` / `Trenameat`                         |
   | `{"ok":false,"errno":N}`  | `Rlerror`                                                    |

3. **Keep the backing file as the data plane.** For the shim, `Tlopen` means "materialize this
   object and tell me when the backing file is current"; reads and writes then go to the real
   descriptor. This is v9fs `cache=fscache` implemented in userspace. `Tread`/`Twrite` are
   implemented by the server for conformant clients and unused by the shim.

4. **`qid.version` is the object version.** Derived from the store's version token (S3 ETag or
   full-object checksum). Staleness is a version mismatch, not an mtime heuristic.

5. **`VfsAdapter` becomes an operations table over handles** (`lookup`, `getattr`, `open`,
   `readdir`, `fsync`, `lock`, `rename`, `unlink`, `release`). `S3Adapter` and `LocalAdapter` are
   ported; the lease and conditional-write logic of ADR 0001 is unchanged underneath.

6. **One server, two clients.** The same 9P server backs the preload shim in Lambda and the
   kernel's v9fs (`mount -t 9p -o trans=unix`) wherever mounting is permitted. A kernel-client run
   in CI is the conformance test for the server.

## Alternatives considered

- **Keep JSON, add handles.** Fixes the path-keyed approximations at the lowest cost. Gives up the
  second client and keeps a protocol only we speak.
- **9P as the data plane too.** No real descriptor exists for a virtual file, so the shim would
  fabricate descriptors and interpose every fd-taking call (`read`, `lseek`, `fstat`, `mmap`,
  `poll`, `readv`, `io_uring`, …); calls musl binds internally would bypass it. Every read becomes
  a round trip. gVisor's gofer left 9P for LISAFS over that round-trip cost.
- **FUSE's protocol in-process.** Would let existing FUSE filesystems plug in, but they assume the
  kernel channel and its caching contract; we would be reimplementing the kernel side of FUSE.
- **Userspace NFS.** Heavier protocol, same absence of a kernel client in Lambda.

## Consequences

- Positive: handle-based identity; multiple volumes and pass-through mounts fall out of the mount
  table; errno, versioning and locking come from the protocol instead of our tables; the server is
  usable with a real mount outside Lambda; the dual-use disclosure names a published standard
  instead of documenting a private wire format.
- Negative: a 9P2000.L server in Node has to be written (no mature library); a C client goes into
  the shim; a new ELF goes back through registry review; `DISCLOSURE` is rewritten; `Twalk` is
  chattier than one `stat` line (mitigated by multi-name walks and the attribute cache).
- Neutral: shim and supervisor ship in one package and negotiate with `Tversion`, so there is no
  mixed-version deployment to support. The JSON protocol, the single-mount `VFS_PREFIX` /
  `VFS_BACKING` form and the path-keyed adapter interface are removed rather than kept alongside:
  nothing outside this repository speaks them.

## Sequencing

Steps 2–4 ship as one release from a `vfs/9p` branch (the publish job only runs on `vfs`), so the
shim's binary goes through registry review once.

1. Restructure the shim into the three layers, still speaking the JSON protocol. Lands the mount
   table (multi-volume) and the fd table on their own. **Done**: `native/vfs_transport.h`,
   `native/vfs_core.h`, `native/vfspreload.c`; `VFS_MOUNTS`; `MountAdapter` on the supervisor side.
2. Move `VfsAdapter` to the handle-based operations table.
3. Replace the wire format with 9P2000.L; rewrite `DISCLOSURE`.
4. Add the kernel v9fs conformance job.

## Open questions

- Whether open-time leases (`lock` volume flag) map to `Tlock` at `Tlopen` or stay server policy.
- Eviction of the backing directory against the `/tmp` quota: an fscache-style cull needs the
  handle table from step 1 to know what is pinned.
- `mmap` of virtual files stays out of scope.
