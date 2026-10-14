# node fs/promises tests

`node/test` is copied verbatim from [nodejs/node v22.23.3](https://github.com/nodejs/node/tree/v22.23.3/test),
the node in the test images (`node:22-alpine`, `node:22-bookworm-slim`). Nothing under `node/` is edited:
a failing test is fixed in the store, not in the test.

- `node/test/parallel/test-fs*` and `node/test/sequential/test-fs*`: every file that uses `fs.promises`,
  `fs/promises` or `{ promises }` (61 files).
- `node/test/common`: node's test harness, whole.
- `node/test/fixtures`: only what those tests read (`x.txt`, `empty.txt`, `baz.js`, `copy/kitchen-sink`).

`run.js` runs each file in its own node with the file's `// Flags:`, its tmpdir under `NODE_TEST_DIR`.
`native/nodefs.sh` runs it in the image as the `node` user against a store:

```sh
sh native/nodefs.sh x64|arm64 alpine|debian volume [--filter <regex>]
```

| store    | where the tests' tmpdir lives                                 |
| -------- | ------------------------------------------------------------- |
| `volume` | a docker named volume at `/data`, created and removed per run |
