# node fs/promises tests

`node/test` is copied verbatim from [nodejs/node v22.23.3](https://github.com/nodejs/node/tree/v22.23.3/test),
the node in the test images (`node:22-alpine`, `node:22-bookworm-slim`). Nothing under `node/` is edited:
a failing test is fixed in the store, not in the test.

- `node/test/parallel/test-fs*` and `node/test/sequential/test-fs*`: every file that uses `fs.promises`,
  `fs/promises` or `{ promises }` (61 files).
- `node/test/common`: node's test harness, whole.
- `node/test/fixtures`: only what those tests read (`x.txt`, `empty.txt`, `baz.js`, `copy/kitchen-sink`).

`nodefs.test.ts` (jest + testcontainers) starts the image at the host's architecture with a fresh docker
named volume at `/data`, then runs each file as one jest test: its own `node` with the file's `// Flags:`,
as the unprivileged `node` user, its tmpdir under `NODE_TEST_DIR=/data/nodefs`. The volume is removed
afterwards.

```sh
yarn test:nodefs                          # alpine
NODEFS_FLAVOUR=debian yarn test:nodefs
yarn test:nodefs -t test-fs-rm            # one file
```
