// The supervisor for native/test.sh: the package's 9P server over two mounts, with an adapter
// that records every hook to /tmp/ops.log and refuses a few paths so the shim's error paths
// are exercised. Runs inside node:22-alpine with the repository at /w (dist built).
const fs = require('fs');
const { P9Server, LocalAdapter, VfsError } = require('/w/dist/index.js');

class Recording extends LocalAdapter {
  hook(op, path) {
    fs.appendFileSync('/tmp/ops.log', `${op} ${path}\n`);
    if (path.includes('denied')) throw VfsError.code('EACCES', `${path}: denied`);
    if (op === 'flush' && path.includes('flushfail')) throw VfsError.code('EIO', `${path}: flush refused`);
    if (op === 'lock' && path.includes('busy')) throw VfsError.code('EAGAIN', `${path}: held elsewhere`);
  }
  async stat(path) { this.hook('stat', path); }
  async fetch(path) { this.hook('fetch', path); }
  async list(path) { this.hook('list', path); }
  async open(path) { this.hook('open', path); }
  async flush(path) { this.hook('flush', path); }
  async mkdir(path) { this.hook('mkdir', path); }
  async unlink(path) { this.hook('unlink', path); }
  async rename(from, to) { this.hook('rename', `${from} ${to}`); }
  async revalidate(path) { this.hook('revalidate', path); }
  async lock(path) { this.hook('lock', path); }
  async unlock(path) { this.hook('unlock', path); }
}

const adapter = new Recording();
new P9Server(
  [
    { mountpoint: '/vfs', backing: '/tmp/vfsstore', adapter },
    { mountpoint: '/b', backing: '/tmp/store/b', adapter },
  ],
  { socket: '/tmp/vfs.sock' }
)
  .listen()
  .then(() => fs.writeFileSync('/tmp/vfs.ready', ''));
