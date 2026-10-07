# Volumes

A volume gives the app a writable directory that is not part of the image and that outlives the
invocation. Declare them under `spec.volumes` in `routes.yaml` (or inline in the deploy step):

```yaml
spec:
  default: 'http://localhost:3000/'
  volumes:
    - 's3://my-bucket:/data'
    - 'file:///tmp/scratch:/scratch'
```

Every entry is mounted. Nothing is mounted in the kernel sense, see [How it works](#how-it-works).

## Syntax

```
<scheme>://<locator>:<mountpoint>[:<flags>]
```

| Part         | Meaning                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------- |
| `scheme`     | `file` or `s3`.                                                                             |
| `locator`    | `file://<dir>`: an absolute directory on the function's `/tmp`. `s3://<bucket>[/<prefix>]`. |
| `mountpoint` | Absolute path the app sees. Must be unique across the volumes.                              |
| `flags`      | Optional, comma-separated, docker `-v` style. Listed below.                                 |

Mountpoints may nest (`/data` and `/data/cache`); the inner volume owns its subtree. A rename across
volumes fails with `EXDEV`, as it does across filesystems, and `mv` falls back to copy and delete.

### `file://`

Backs the mountpoint with a directory on `/tmp`. State persists across warm invocations of one
execution environment and is gone on a cold start. Use it for scratch space that must survive a
request but not an instance.

### `s3://`

Backs the mountpoint with a bucket (and optional key prefix). Objects are fetched into the backing
directory the first time the app opens them, directory listings come from the bucket, and a file is
uploaded when the app closes or `fsync`s it. Directories are objects named `<key>/`, so an empty
directory survives a cold start.

The deploy derives the execution role's grant from the manifest: `s3:ListBucket` and
`s3:GetBucketLocation` on the bucket, `s3:GetObject`/`PutObject`/`DeleteObject` on `<prefix>/*`. The
bucket must already exist.

## Flags

| Flag           | Effect                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lock`         | Hold a lease on the object for every open-for-write/close window, not only while an advisory lock is held. See [Sharing a volume](#sharing-an-s3-volume-between-instances).                          |
| `local=<glob>` | Files matching the glob never reach the store; the backing directory is the whole story. The glob is relative to the mountpoint; one without `/` matches a name at any depth. Repeat for more globs. |

A flag may be given as `lock`, `lock=1`/`true`, or `lock=0`/`false`. Globs may use `*`, `?` and
`{a,b}`; a glob may not be absolute or contain `..`.

```yaml
volumes:
  - 's3://my-bucket:/s3:local=*-{journal,wal,shm}'
  - 's3://my-bucket/uploads:/uploads:lock'
```

## Sharing an `s3://` volume between instances

Several function instances can use the same `s3://` volume at once.

**Reads.** Each `stat`/`open` re-checks the object (ETag, plus S3's CRC32 checksum when the object
has one) at most every 2 s and refetches when it changed, so other instances' writes become visible
on the next open.

**Writes.** The upload is conditional on the ETag the local copy was based on. If the object changed
meanwhile the app's `close()` or `fsync()` fails with `ESTALE` instead of overwriting; the local copy
is refreshed so the next open sees the current object.

**Locks.** When the app takes an advisory write lock (`fcntl`/`flock`, as SQLite and lockfile
libraries do), the volume takes a lease: a conditional create of `<prefix>/.rowdy/locks/<key>` that
lives 30 s and is renewed while the lock is held. A contended lease surfaces as `EAGAIN`
(`SQLITE_BUSY` to SQLite), and the object is re-checked when the lock is granted so a transaction
never starts on a stale base. Instances therefore serialize their write transactions; a lease left
behind by a crashed instance expires on its own. With the `lock` flag the lease covers every
open-for-write/close window, for programs that do not lock.

`.rowdy/` is hidden from directory listings.

Design and trade-offs: [ADR 0001](https://github.com/scaffoldly/rowdy/blob/vfs/docs/adr/0001-multi-writer-leases.md).

### SQLite

```yaml
volumes:
  - 's3://my-bucket:/s3:local=*-{journal,wal,shm}'
```

Open the database under the mountpoint (`/s3/db/app.sqlite`), set a `busy_timeout` of a few
seconds so `SQLITE_BUSY` retries, and keep the default rollback journal. The journal, WAL and shared
memory sidecars are per-instance state and must stay out of the bucket, which is what the `local=`
glob does. WAL mode needs shared memory between writers and does not work across instances.

A commit from a contended instance takes a lease round trip plus the upload, so writers serialize
at roughly one commit per second each under contention; uncontended commits take the upload only.

## Cache and eviction

The backing directory is on `/tmp`, which Lambda sizes between 512 MB and 10 GB. Fetched copies
count against a budget of half the filesystem (`cacheBytes` on the adapter). Before fetching, the
least recently used copies are turned back into placeholders until the new one fits. A copy that is
open, or that has edits not yet uploaded, is never evicted.

## How it works

The Lambda sandbox denies every kernel-mediated option (`/dev/fuse`, `mount(2)`, namespaces,
ptrace, seccomp-notify). Rowdy instead writes the
[`@scaffoldly/rowdy-vfs`](https://github.com/scaffoldly/rowdy/tree/vfs) shim to
`/tmp/rowdy/vfspreload.so` and prepends it to the app's `LD_PRELOAD`. The libc path calls the app
makes (`open`, `stat`, `opendir`, `rename`, `unlink`, `mkdir`, `getcwd`, `realpath`, …) are rewritten
in-process from the mountpoint to the backing directory, and the shim's `VFS_MOUNTS` carries the
table (`/s3=/tmp/vfsstore:/scratch=/tmp/scratch`).

The shim is a 9P2000.L client. Before the app opens, lists, locks, renames or removes something it
walks the path on rowdy's in-process 9P server over a unix socket (`VFS_SOCKET`); the server's
adapter for that mount fetches, lists, leases or uploads as needed, and replies with a Linux errno
when it cannot (`ESTALE`, `EAGAIN`, `EEXIST`, `ENOENT`, `EXDEV`). Data never crosses the socket:
`read`/`write` go straight to the backing file. The same server passes the kernel's v9fs client in
CI. Design: [ADR 0002](https://github.com/scaffoldly/rowdy/blob/vfs/docs/adr/0002-handle-based-core-and-9p-control-plane.md).

Rowdy's own process is never preloaded; an existing `LD_PRELOAD` is kept.

## Limits

- Only dynamically linked musl (alpine) binaries that go through libc see the mountpoint. Static
  binaries and Go programs that issue raw syscalls do not.
- `mmap` of a file under the mountpoint is not translated; neither are `nftw`, `glob` or
  `posix_spawn` paths.
- There is no mountpoint, so a process started outside rowdy cannot see it.
- `s3://` consistency is per object. A multi-file update is not atomic across instances.

## Errors the app may see

| errno    | Where                   | Meaning                                                                              |
| -------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `ESTALE` | `close`, `fsync`        | The object changed since this copy was fetched. Re-open and redo the write.          |
| `EAGAIN` | `fcntl`/`flock`, `open` | Another instance holds the lease (or the base changed under a lock). Retry.          |
| `EEXIST` | `open(O_CREAT\|O_EXCL)` | The object exists, checked atomically in the bucket.                                 |
| `EXDEV`  | `rename`                | Source and destination are on different volumes.                                     |
| `EIO`    | `close`, `fsync`        | The upload failed for a reason other than a conflict. Details in the function's log. |

## Logs

Volume activity is logged under the `vfs` component. A healthy volume is silent at `info`: a 9P
request that fails with anything other than `ENOENT` (a miss before a create) or `EAGAIN` (a
contended lock) is logged at `warn` with its path and errno. `debug` (`--log-level debug`, or
`log-level: debug` in the action) shows every request, and every fetch, upload and lease.

## Versioning

`@scaffoldly/rowdy-vfs` is pinned by commit, not by registry version: `package.json` points at the
`rowdy-vfs-<sha>.tgz` asset that the `vfs` branch's CI uploads to the rolling `vfs-builds` release
on every push, so a shim change reaches rowdy without waiting on the registry's review of the
binary. The npm release of the package is the reviewed, attested one for other consumers.
