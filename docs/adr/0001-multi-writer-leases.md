# ADR 0001: Multi-writer access to S3-backed volumes

- Status: Accepted (2026-10-05)
- Scope: `@scaffoldly/rowdy-vfs` (`S3Adapter`, shim) and rowdy's `volumes:` wiring
- Relates to: scaffoldly/rowdy#27

## Context

A rowdy volume `s3://<bucket>[/<prefix>]:<mountpoint>` gives a Lambda container a writable
directory backed by a bucket. The shim rewrites libc path calls to a local backing directory and
tells the supervisor what happened; the `S3Adapter` materializes objects on first open and uploads
files on close/fsync. Lambda runs many execution environments at once, each with its own backing
copy, so two instances can write the same path concurrently.

Today the adapter is **optimistic**: every upload is a conditional `PutObject` (`If-Match` on the
ETag the local copy was based on, `If-None-Match: *` for a new object). A conflict fails the
caller's `close()` or `fsync()` with `ESTALE`. That is correct — nothing is silently lost — but it
makes the second writer fail rather than wait, and it offers nothing to SQLite, whose transactions
need a _before_ hook (take the lock) as well as the _after_ hook we have (upload).

Two other latent properties shape the decision:

- `fetch` trusts a local copy forever. A long-lived instance never sees another instance's writes.
- Refetch writes a temp file and renames it over the local path. A process holding the old file
  open (SQLite does, for the life of a connection) keeps reading the old inode.

## Decision

Serialize writers with **leases stored in the bucket itself**, acquired at the granularity the
caller already expresses, and keep the conditional uploads as the safety net underneath.

1. **Lease primitive in `S3Adapter`.** A lease for key `K` is the object `<prefix>/.rowdy/locks/K`
   with body `{ owner, expiresAt }`. Acquire = `PutObject If-None-Match: *` (atomic create);
   release = `DeleteObject`; a lease past `expiresAt` may be taken over with `If-Match` on the stale
   lease's ETag so two takers cannot both succeed. Contention returns `EAGAIN` after a bounded wait.
   S3 conditional writes are sufficient for a mutex; no second service is introduced.

2. **Revalidation on read.** `fetch` (and `stat` for a non-placeholder) compares the remote ETag
   with the local entry's and refetches when they differ, rate-limited by a short TTL so `stat`
   storms do not become `HEAD` storms.

3. **Refetch into the existing inode.** Replace the file's contents in place (`O_TRUNC` + copy)
   instead of rename-over, so open descriptors observe the new bytes. SQLite's file change counter
   in the header then invalidates its page cache, which is the path SQLite is designed for.

4. **Transaction-grained leases for SQLite via `fcntl`.** The shim hooks `fcntl(F_SETLK/F_SETLKW)`
   on tracked descriptors and forwards the lock ladder as protocol ops: `SHARED` → `revalidate`,
   `RESERVED`/`EXCLUSIVE` → `lock`, `UNLCK` after a write → `flush` then `unlock`. A contended lease
   is returned as `EAGAIN`, which SQLite reports as `SQLITE_BUSY` and retries under `busy_timeout`.
   No change in the application; no WAL (see ADR context in the README: WAL's `-shm` is
   per-host shared memory and its three-file consistency does not survive per-object uploads).

   Two details close the read-then-write window. `lock` compares the remote ETag with the one this
   instance last read: a mismatch means another writer committed between our `SHARED` and
   `RESERVED`, so the lease is given back and `EAGAIN` is returned *before* any write; SQLite drops
   `SHARED` on that `BUSY`, re-takes it (`revalidate` fetches the new base) and the transaction
   proceeds on fresh pages. And "locally modified" is decided by bytes, not mtime: a copy whose
   checksum equals the base version's (a rollback that restored the base after a failed commit) is
   treated as clean, so it is neither re-uploaded nor protected from the next revalidation. The
   digest is S3's full-object additional checksum (uploads set `CRC32`; `HEAD`/`GET` ask for it with
   `ChecksumMode: ENABLED`), not the ETag, which is only an MD5 for single-part SSE-S3 objects.
   Computing it is one streamed pass over the local file, and only when the size still matches.

5. **Open-grained leases for plain files, opt-in per volume.** `open(O_WRONLY|O_RDWR)` acquires,
   `close` releases after `flush`. Opt-in (`s3://bucket:/mnt?lock=1` or a manifest flag) because many
   workloads prefer fail-fast `ESTALE` to waiting, and the lease costs two extra S3 calls per write.

Protocol additions (`lock`, `unlock`, `revalidate`) are documented in `DISCLOSURE` before the shim
sends them; the disclosure must stay truthful.

## Consequences

- Writes to one path are serialized across instances; readers converge after the writer's upload.
- A write transaction costs roughly lease `PUT` + `HEAD` + object `PUT` + lease `DELETE`, i.e.
  ~150–300 ms plus the upload, so this suits low write rates (configuration, small databases,
  user uploads), not hot tables. That is a property of whole-object storage, not of the lease.
- A crashed holder blocks writers for at most the lease TTL. The TTL is a trade-off between
  recovery time and the risk of a slow-but-alive writer losing its lease; the holder renews while a
  transaction is open.
- Correctness does not depend on the lease: the conditional upload still rejects a stale write, so a
  misbehaving or expired-and-taken-over holder gets `ESTALE`, never a silent overwrite.
- Clock skew between instances only affects takeover timing, not safety (safety comes from
  `If-Match`/`If-None-Match`).

## Alternatives considered

- **Keep optimistic only.** Simple, already shipped. Rejected as the end state because SQLite
  cannot work across instances without a _pre_-write hook, and because `close()` failing is a poor
  experience for interactive writers (the `/s3` console).
- **WAL mode for SQLite.** Solves single-host concurrency, which Lambda does not have. Adds a
  per-host `-shm` that must never be uploaded and a three-file consistency problem across per-object
  uploads. Rejected.
- **DynamoDB (or similar) for leases.** Stronger TTL semantics and consistent reads, but a second
  service, more IAM, and a dependency for a feature whose whole point is "just a bucket". Could be
  added later behind the same `lock`/`unlock` protocol if S3 lease latency proves limiting.
- **Primary election with write forwarding (LiteFS-style).** One instance owns writes; others
  forward. Much more machinery (election, forwarding transport, failover) for the same serialization
  guarantee the lease gives per path. Revisit only if per-transaction lease latency is unacceptable.
- **Single writer by deployment** (reserved concurrency 1, or a dedicated writer function). Works,
  but caps the application's scale to get database correctness, and is a deployment-time decision
  the volume should not require.
- **Not SQLite** (DynamoDB, Turso, Postgres) for data that is genuinely hot and multi-writer. Still
  the right answer for that data; out of scope for the volume.

## Work breakdown

Tracked as issues under scaffoldly/rowdy#27, in dependency order: inode-preserving refetch +
revalidation; lease primitive and protocol ops; `fcntl` hook (SQLite); opt-in open-time leases.

## Appendix A: effect on non-SQLite workloads

The decision is additive for workloads that do not use SQLite, and the defaults do not change for
them:

- Revalidation helps everyone: an instance sees other instances' writes on the next open instead of
  serving a stale copy forever. In-place refetch only matters to processes that hold files open.
- The `fcntl` hook only fires for programs that take POSIX locks. Plain `writeFile`/`readFile` never
  call it. Programs that do lock (SQLite, lockfile libraries, LevelDB/RocksDB via `flock`) get
  cross-instance exclusion without changes; `flock()` should be hooked alongside `fcntl` for them.
- Open-time leases are opt-in per volume (`?lock=1`). Without them, plain files keep the
  optimistic `ESTALE`-on-conflict behaviour.

| Pattern                                              | Verdict                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write-once files (uploads, images, build artifacts)  | Good as-is; leases unnecessary                                                                                                                                                              |
| Read-mostly config/data (JSON, SQLite read replicas) | Good; revalidation makes updates propagate                                                                                                                                                  |
| Read-modify-write of one file from many instances    | Needs `?lock=1` **and** opening `O_RDWR` before reading. Read-close-then-write is a TOCTOU race the lease cannot cover; `ESTALE` + retry still preserves correctness                        |
| Shared append log (`O_APPEND`, long-open fd)         | Wrong tool: nothing uploads until close/fsync, and two instances' appends cannot merge — a lease serializes but does not merge. Use per-instance log objects, or S3 Express append          |
| `O_EXCL` create as a mutex (`.lock` files, git)      | Works locally; cross-instance it is caught late by `If-None-Match: *` at `close()`. Could be made atomic by mapping `O_CREAT\|O_EXCL` to a lease-style conditional create — small follow-up |
| mmap-based stores (LMDB)                             | Not covered: mmap'd writes do not flush until `msync`/`close`, and those engines assume one host. Would need an `msync` hook; not planned                                                   |
| Many small files (`node_modules`-like)               | Works; first access per instance is a HEAD/GET each. Listing placeholders help. Cold starts pay for it                                                                                      |
| Large objects (video)                                | Works; whole-object materialize on first open per instance, whole-object upload on close. No range reads — pre-existing ceiling                                                             |
| Processes that `fsync` constantly                    | Upload per fsync: chatty and slow. Fine for correctness, bad for throughput                                                                                                                 |

The lease design serializes _who writes an object_; it never merges content. Anything whose
correctness needs merging (logs, counters in a text file) should be redesigned (one object per
instance or record) or moved to a real database — the same constraint as any shared filesystem
without a server in front of it.
