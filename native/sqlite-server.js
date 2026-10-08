// The supervisor for native/sqlite.sh: the package's 9P server with /vfs on a local directory and,
// when S3_BUCKET and S3_PREFIX are set, /s3 on the bucket (the sidecars local, as on nuss.io). On
// SIGTERM it closes and empties its prefix. Needs dist/ built.
/* global require, __dirname, process */
const fs = require('fs');
const path = require('path');
const { P9Server, LocalAdapter, S3Adapter } = require(path.join(__dirname, '..', 'dist', 'index.js'));

const { S3_BUCKET, S3_PREFIX } = process.env;

// Every adapter decision and S3 round trip, for the report when an /s3 run fails.
const record = (message, params) =>
  fs.appendFileSync('/tmp/s3-adapter.log', `${new Date().toISOString()} ${message} ${JSON.stringify(params ?? {})}\n`);
const mounts = [{ mountpoint: '/vfs', backing: '/tmp/vfsstore', adapter: new LocalAdapter() }];

let sdk, client;
if (S3_BUCKET) {
  sdk = require('@aws-sdk/client-s3');
  client = new sdk.S3Client({});
  mounts.push({
    mountpoint: '/s3',
    backing: '/tmp/s3store',
    adapter: new S3Adapter({
      bucket: S3_BUCKET,
      prefix: S3_PREFIX,
      mountpoint: '/s3',
      backing: '/tmp/s3store',
      client,
      localOnly: ['*-{journal,wal,shm}'],
      log: record,
      trace: (op, { headers, ...rest } = {}) => record(op, { ...rest, etag: headers?.etag }),
    }),
  });
}

const empty = async () => {
  for (;;) {
    const listed = await client.send(new sdk.ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: `${S3_PREFIX}/` }));
    const keys = (listed.Contents ?? []).map(({ Key }) => ({ Key }));
    if (!keys.length) return;
    await client.send(new sdk.DeleteObjectsCommand({ Bucket: S3_BUCKET, Delete: { Objects: keys } }));
  }
};

const server = new P9Server(mounts, { socket: '/tmp/rowdy/vfs.sock' });
server.listen().then(() => fs.writeFileSync('/tmp/vfs.ready', ''));

process.on('SIGTERM', () => {
  server
    .close()
    .then(() => (client ? empty() : undefined))
    .then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`sqlite-server: ${error.message}\n`);
        process.exit(1);
      }
    );
});
