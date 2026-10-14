// The supervisor for nodefs.test.ts's VFS stores: the package's 9P server for one mount, /vfs, backed by
// /tmp/vfsstore, run without LD_PRELOAD as rowdy runs it. The repository is mounted at /w.
//
//   NODEFS_STORE=s3   S3Adapter on NODEFS_S3_BUCKET under NODEFS_S3_PREFIX, credentials from the default
//                     chain; NODEFS_S3_ENDPOINT points it at an S3-compatible server (path-style) instead.
//                     Its events and S3 round trips go to stdout as JSON lines, for the test to count.
const fs = require('fs');
const { P9Server, S3Adapter } = require('/w/dist/index.js');
const { S3Client } = require('/w/node_modules/@aws-sdk/client-s3');

const MOUNT = '/vfs';
const BACKING = '/tmp/vfsstore';

/** One JSON line on stdout per adapter event (`log`) and per S3 round trip (`trace`); headers left out. */
const line =
  (kind) =>
  (message, params = {}) => {
    const entry = { t: Date.now(), kind, message, ...params };
    delete entry.headers;
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  };

const adapter = () => {
  const store = process.env.NODEFS_STORE;
  if (store === 's3') {
    const endpoint = process.env.NODEFS_S3_ENDPOINT;
    return new S3Adapter({
      bucket: process.env.NODEFS_S3_BUCKET,
      prefix: process.env.NODEFS_S3_PREFIX,
      mountpoint: MOUNT,
      backing: BACKING,
      client: new S3Client(endpoint ? { endpoint, forcePathStyle: true } : {}),
      log: line('log'),
      trace: line('trace'),
    });
  }
  throw new Error(`NODEFS_STORE must be s3, not '${store}'`);
};

fs.mkdirSync(BACKING, { recursive: true });
new P9Server([{ mountpoint: MOUNT, backing: BACKING, adapter: adapter() }], { socket: '/tmp/vfs.sock' })
  .listen()
  .then(() => fs.writeFileSync('/tmp/vfs.ready', ''));
