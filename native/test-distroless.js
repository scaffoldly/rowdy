// The shim in the image nuss.io deploys: gcr.io/distroless/nodejs22-debian12 as nonroot, where node
// is the only process ever preloaded (no shell, no coreutils). This process is the supervisor (the
// package's 9P server, recording every adapter hook); a preloaded child node does the work.
//
//   sh native/distroless.sh x64|arm64
/* global require, __dirname, process, console */
const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { P9Server, LocalAdapter } = require(path.join(__dirname, '..', 'dist', 'index.js'));

const SHIM = process.env.SHIM;
const BACKING = '/tmp/vfsstore';
const SOCKET = '/tmp/rowdy/vfs.sock';

const ops = [];
class Recording extends LocalAdapter {
  async stat(p) {
    ops.push(`stat ${p}`);
  }
  async fetch(p) {
    ops.push(`fetch ${p}`);
  }
  async list(p) {
    ops.push(`list ${p}`);
  }
  async open(p) {
    ops.push(`open ${p}`);
  }
  async flush(p) {
    ops.push(`flush ${p}`);
  }
  async mkdir(p) {
    ops.push(`mkdir ${p}`);
  }
  async unlink(p) {
    ops.push(`unlink ${p}`);
  }
  async rename(from, to) {
    ops.push(`rename ${from} ${to}`);
  }
  async revalidate(p) {
    ops.push(`revalidate ${p}`);
  }
  async lock(p) {
    ops.push(`lock ${p}`);
  }
  async unlock(p) {
    ops.push(`unlock ${p}`);
  }
}

// Runs in the preloaded child. Each check names itself so a failure says which one.
const child = `
const assert = require('assert');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const check = (name, fn) => { try { fn(); } catch (e) { console.error('FAIL ' + name + ': ' + e.message); process.exit(1); } };

check('preloaded', () => assert.match(fs.readFileSync('/proc/self/maps', 'utf8'), /vfspreload\\.so/));

check('files', () => {
  fs.mkdirSync('/vfs/d');
  fs.writeFileSync('/vfs/d/a.txt', 'hello');
  assert.strictEqual(fs.readFileSync('/vfs/d/a.txt', 'utf8'), 'hello');
  assert.strictEqual(fs.statSync('/vfs/d/a.txt').size, 5);
});

check('rename and list', () => {
  fs.renameSync('/vfs/d/a.txt', '/vfs/d/b.txt');
  assert.deepStrictEqual(fs.readdirSync('/vfs/d'), ['b.txt']);
});

check('paths handed back', () => {
  assert.strictEqual(fs.realpathSync('/vfs/d/b.txt'), '/vfs/d/b.txt');
  process.chdir('/vfs/d');
  assert.strictEqual(process.cwd(), '/vfs/d');
  process.chdir('/');
});

check('a script under the mount runs', () => {
  fs.writeFileSync('/vfs/hello.js', 'console.log(require("fs").readFileSync("/vfs/d/b.txt", "utf8"))');
  assert.strictEqual(execFileSync(process.execPath, ['/vfs/hello.js'], { encoding: 'utf8' }).trim(), 'hello');
});

check('sqlite WAL, two connections', () => {
  const a = new DatabaseSync('/vfs/w.sqlite');
  a.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);');
  const b = new DatabaseSync('/vfs/w.sqlite');
  assert.strictEqual(b.prepare('SELECT count(*) AS n FROM t').get().n, 1);
  b.exec('INSERT INTO t VALUES (2)');
  assert.strictEqual(a.prepare('SELECT count(*) AS n FROM t').get().n, 2);
  b.close();
  a.close();
});

// libuv's threadpool: the fs.promises calls run off the main thread
fs.promises.readFile('/vfs/d/b.txt', 'utf8').then(
  (v) => { if (v !== 'hello') { console.error('FAIL threadpool: ' + v); process.exit(1); } console.log('child: ok'); },
  (e) => { console.error('FAIL threadpool: ' + e.message); process.exit(1); }
);
`;

const run = (args, env) =>
  new Promise((resolve) =>
    execFile(process.execPath, args, { env, encoding: 'utf8' }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })
    )
  );

(async () => {
  assert.strictEqual(process.getuid(), 65532, 'runs as nonroot');
  assert.ok(SHIM && fs.existsSync(SHIM), `SHIM ${SHIM} missing`);
  fs.mkdirSync(BACKING, { recursive: true });

  const server = await new P9Server([{ mountpoint: '/vfs', backing: BACKING, adapter: new Recording() }], {
    socket: SOCKET,
  }).listen();
  try {
    const env = { ...process.env, LD_PRELOAD: SHIM, VFS_MOUNTS: `/vfs=${BACKING}`, VFS_SOCKET: SOCKET };
    const { code, stdout, stderr } = await run(['--no-warnings', '-e', child], env);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    assert.strictEqual(code, 0, 'preloaded child failed');

    for (const op of [
      'mkdir /vfs/d',
      'flush /vfs/d/a.txt',
      'rename /vfs/d/a.txt /vfs/d/b.txt',
      'fetch /vfs/hello.js',
      'lock /vfs/w.sqlite',
      'unlock /vfs/w.sqlite',
    ]) {
      assert.ok(ops.includes(op), `supervisor never saw '${op}' in: ${ops.join(', ')}`);
    }

    // the data reached the backing directory: read it here, without the preload
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(BACKING, 'w.sqlite'), { readOnly: true });
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM t').get().n, 2);
    db.close();
    console.log('distroless: ok');
  } finally {
    await server.close();
  }
})().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
