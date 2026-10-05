#!/bin/sh
# Integration test for the shim: compiles it inside node:22-alpine and drives it
# through busybox, node (libuv) and a C fopen caller under LD_PRELOAD.
#
#   sh native/test.sh            # host architecture
#   sh native/test.sh arm64      # or x64, via docker --platform
set -eu

if [ -z "${VFS_STAGE:-}" ]; then
  if [ ! -f /.dockerenv ]; then
    arch="${1:-}"
    platform=""
    case "$arch" in
      x64)   platform="--platform linux/amd64" ;;
      arm64) platform="--platform linux/arm64" ;;
    esac
    root="$(cd "$(dirname "$0")/.." && pwd)"
    exec docker run --rm $platform -v "$root/native:/n:ro" node:22-alpine sh /n/test.sh
  fi
  apk add --no-cache gcc musl-dev linux-headers >/dev/null 2>&1
  gcc -O2 -shared -fPIC -Wall -Wextra -Werror /n/vfspreload.c -o /tmp/vfspreload.so
  echo "compile: ok"
  # the shell performs redirections itself, so it must be preloaded too
  exec env VFS_STAGE=1 LD_PRELOAD=/tmp/vfspreload.so VFS_PREFIX=/vfs VFS_BACKING=/tmp/vfsstore sh "$0"
fi
fail() { echo "FAIL: $*"; exit 1; }

# busybox (dynamically linked against musl) path ops
ls /vfs >/dev/null || fail "ls /vfs"
echo hi > /vfs/a
[ "$(cat /vfs/a)" = "hi" ] || fail "cat"
[ -f /tmp/vfsstore/a ] || fail "persist to backing"
mkdir /vfs/d
mv /vfs/a /vfs/d/b
[ "$(cat /vfs/d/b)" = "hi" ] || fail "mv"
cp /vfs/d/b /vfs/d/c
touch /vfs/d/c
chmod 600 /vfs/d/c
[ "$(stat -c %a /vfs/d/c)" = "600" ] || fail "chmod/stat"
truncate -s 0 /vfs/d/c
[ ! -s /vfs/d/c ] || fail "truncate"
ln -s /vfs/d/b /vfs/lnk
[ "$(cat /vfs/lnk)" = "hi" ] || fail "symlink follow"
[ "$(readlink /vfs/lnk)" = "/vfs/d/b" ] || fail "readlink reverse-translate: $(readlink /vfs/lnk)"
ln /vfs/d/b /vfs/hard
[ "$(cat /vfs/hard)" = "hi" ] || fail "hardlink"
[ "$(cd /vfs/d && pwd)" = "/vfs/d" ] || fail "chdir/getcwd: $(cd /vfs/d && pwd)"
[ "$(cd /vfs/d && cat b)" = "hi" ] || fail "relative after chdir"
[ "$(ls /vfs | sort | tr '\n' ' ')" = "d hard lnk " ] || fail "ls: $(ls /vfs)"
rm /vfs/hard /vfs/lnk /vfs/d/c
rm /vfs/d/b
rmdir /vfs/d
[ -z "$(ls /vfs)" ] || fail "cleanup: $(ls /vfs)"
echo "busybox: ok"

# node (libuv): statx via raw syscall, openat, scandir, realpath, mkdtemp, rename
node -e '
const fs = require("fs"), path = require("path"), assert = require("assert");
assert.ok(fs.statSync("/vfs").isDirectory());
assert.ok(fs.lstatSync("/vfs").isDirectory());
fs.writeFileSync("/vfs/n.txt", "node");
assert.strictEqual(fs.statSync("/vfs/n.txt").size, 4);
assert.ok(fs.existsSync("/vfs/n.txt"));
assert.strictEqual(fs.readFileSync("/vfs/n.txt", "utf8"), "node");
fs.mkdirSync("/vfs/x/y", { recursive: true });
fs.renameSync("/vfs/n.txt", "/vfs/x/y/n.txt");
assert.deepStrictEqual(fs.readdirSync("/vfs/x/y"), ["n.txt"]);
assert.strictEqual(fs.realpathSync("/vfs/x/../x/y/n.txt"), "/vfs/x/y/n.txt");
const t = fs.mkdtempSync("/vfs/tmp-");
assert.ok(t.startsWith("/vfs/tmp-") && fs.statSync(t).isDirectory(), t);
assert.ok(fs.existsSync("/tmp/vfsstore/" + path.basename(t)));
fs.symlinkSync("/vfs/x/y/n.txt", "/vfs/s");
assert.strictEqual(fs.readlinkSync("/vfs/s"), "/vfs/x/y/n.txt");
assert.strictEqual(fs.readFileSync("/vfs/s", "utf8"), "node");
process.chdir("/vfs/x");
assert.strictEqual(process.cwd(), "/vfs/x");
assert.strictEqual(fs.readFileSync("y/n.txt", "utf8"), "node");
process.chdir("/");
fs.rmSync("/vfs/x", { recursive: true });
fs.rmSync(t, { recursive: true });
fs.unlinkSync("/vfs/s");
assert.deepStrictEqual(fs.readdirSync("/vfs"), []);
assert.ok(!fs.existsSync("/vfsx"));
console.log("node: ok");
'

# fopen path via a tiny C program
cat > /tmp/f.c <<'EOF'
#include <stdio.h>
#include <string.h>
int main(void) {
  FILE *f = fopen("/vfs/f.txt", "w"); if (!f) return 1;
  fputs("fopen", f); fclose(f);
  char b[16] = {0}; f = fopen("/vfs/f.txt", "r"); if (!f) return 2;
  fgets(b, sizeof b, f); fclose(f);
  if (strcmp(b, "fopen")) return 3;
  if (remove("/vfs/f.txt")) return 4;
  return 0;
}
EOF
gcc /tmp/f.c -o /tmp/f && /tmp/f || fail "fopen/remove (rc=$?)"
echo "fopen: ok"

# off switch: without the preload, /vfs does not exist
env -u LD_PRELOAD sh -c '[ ! -e /vfs ]' || fail "/vfs visible without preload"
env -u LD_PRELOAD sh -c '[ -d /tmp/vfsstore ]' || fail "backing dir missing"

# supervisor socket tests
cat > /tmp/server.js <<'SRV'
const net = require("net");
const fs = require("fs");
try { fs.unlinkSync("/tmp/vfs.sock"); } catch(e) {}
net.createServer(c => {
  let buf = "";
  c.on("data", d => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const req = JSON.parse(line);
      const path = req.path || req.from || "";
      fs.appendFileSync("/tmp/ops.log", req.op + " " + path + "\n");
      if (path.includes("denied")) {
        c.write('{"ok":false,"errno":13}\n');
      } else if (req.op === "flush" && path.includes("flushfail")) {
        c.write('{"ok":false,"errno":5}\n');
      } else {
        c.write('{"ok":true}\n');
      }
    }
  });
}).listen("/tmp/vfs.sock");
SRV
node /tmp/server.js &
SRVPID=$!
sleep 0.2

export VFS_SOCKET=/tmp/vfs.sock
rm -f /tmp/ops.log

if cat /vfs/denied 2>&1 | grep -q "Permission denied"; then
  :
else
  fail "cat /vfs/denied did not fail with Permission denied"
fi

if node -e "fs.writeFileSync('/vfs/flushfail', 'x')" 2>&1 | grep -q "EIO"; then
  :
else
  fail "flushfail did not throw EIO"
fi

rm -f /tmp/ops.log
touch /vfs/tracked
ls /vfs >/dev/null
mkdir /vfs/d2
mv /vfs/tracked /vfs/d2/tracked2
rm /vfs/d2/tracked2
rmdir /vfs/d2
echo x > /tmp/notvfs   # outside the prefix: must not reach the supervisor

LOG=$(cat /tmp/ops.log | tr '\n' ' ')
case "$LOG" in
  *"fetch /vfs/tracked open /vfs/tracked flush /vfs/tracked list /vfs mkdir /vfs/d2 rename /vfs/tracked stat /vfs/d2/tracked2 unlink /vfs/d2/tracked2 unlink /vfs/d2 "*)
    :
    ;;
  *)
    fail "log did not match: $LOG"
    ;;
esac

if grep -q "/tmp/notvfs" /tmp/ops.log 2>/dev/null; then
  fail "logged non-/vfs path"
fi

kill $SRVPID
wait $SRVPID 2>/dev/null || true

if ls /vfs 2>/dev/null; then
  fail "ls /vfs should fail with unreachable socket"
fi

unset VFS_SOCKET
echo "socket: ok"

echo "ALL OK"
