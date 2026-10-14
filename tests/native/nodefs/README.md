# node fs/promises tests

`node/test` is copied verbatim from [nodejs/node v22.23.3](https://github.com/nodejs/node/tree/v22.23.3/test),
the node in the test images (`node:22-alpine`, `node:22-bookworm-slim`). Nothing under `node/` is edited:
a failing test is fixed in the store, not in the test.

- `node/test/parallel/test-fs*` and `node/test/sequential/test-fs*`: every file that uses `fs.promises`,
  `fs/promises` or `{ promises }` (61 files).
- `node/test/common`: node's test harness, whole.
- `node/test/fixtures`: only what those tests read (`x.txt`, `empty.txt`, `baz.js`, `copy/kitchen-sink`).

`nodefs.test.ts` (jest + testcontainers) runs each file as one jest test, in the image at the host's
architecture: its own `node` with the file's `// Flags:`, as the unprivileged `node` user, its tmpdir under
`NODE_TEST_DIR` in each store:

| store                  | the container                                                                                                                                                                                                                                                | failures      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `volume`               | a fresh docker named volume at `/data`, removed afterwards; no shim                                                                                                                                                                                          | fail the run  |
| `vfs+s3` / `vfs+minio` | `LD_PRELOAD`, `VFS_MOUNTS=/vfs=/tmp/vfsstore` and `VFS_SOCKET` in its environment, so every process in it is preloaded; `server.js` (the package's 9P server, started without the shim) serves `/vfs` from a bucket under a fresh prefix, removed afterwards | reported only |

The bucket is `NODEFS_S3_BUCKET` on AWS (`vfs+s3`) when `AWS_ACCESS_KEY_ID` is set, else a MinIO started
for the run on a docker network of its own, with credentials and a bucket made for it (`vfs+minio`); MinIO
is pulled from `cgr.dev/chainguard/minio`, as it is no longer published to Docker Hub or quay.io. Either
needs the built shim and `dist/` (`sh native/build.sh <arch>`, `yarn build`). `NODEFS_S3_ENDPOINT` points
the AWS case at another S3-compatible server. With `GITHUB_STEP_SUMMARY` set, the run appends a table of
every file's outcome in each store.

```sh
yarn test:nodefs                          # alpine
NODEFS_FLAVOUR=debian yarn test:nodefs
yarn test:nodefs -t test-fs-rm            # one file
```
