#!/bin/sh
# Integration test for the shim built by native/build.sh. Drives it through the image's own shell
# and coreutils (busybox on alpine, GNU on debian), node (libuv), C callers, several mounts and the
# package's 9P server, under LD_PRELOAD.
#
#   sh native/test.sh x64|arm64 alpine|debian
set -eu

if [ -z "${VFS_STAGE:-}" ]; then
  if [ ! -f /.dockerenv ]; then
    arch="${1:-}"; flavour="${2:-}"
    case "$arch" in
      x64)   platform=linux/amd64 ;;
      arm64) platform=linux/arm64 ;;
      *) echo "usage: $0 x64|arm64 alpine|debian" >&2; exit 2 ;;
    esac
    case "$flavour" in
      alpine) image=node:22-alpine ;;
      debian) image=node:22-bookworm-slim ;;
      *) echo "usage: $0 x64|arm64 alpine|debian" >&2; exit 2 ;;
    esac
    root="$(cd "$(dirname "$0")/.." && pwd)"
    [ -f "$root/dist/index.js" ] || { echo "dist/index.js missing: run yarn build first (the test supervisor is the package's 9P server)" >&2; exit 2; }
    [ -f "$root/lib/linux-$arch/vfspreload.so" ] || { echo "lib/linux-$arch/vfspreload.so missing: run native/build.sh $arch first" >&2; exit 2; }
    exec docker run --rm --platform "$platform" -e FLAVOUR="$flavour" -e SHIM="/w/lib/linux-$arch/vfspreload.so" \
      -v "$root:/w:ro" "$image" sh /w/native/test.sh
  fi
  # C toolchain for the test callers only; the shim under test is the built artifact.
  case "$FLAVOUR" in
    alpine) apk add --no-cache gcc musl-dev linux-headers >/dev/null 2>&1 ;;
    debian) { apt-get -qq update && apt-get -qq install -y --no-install-recommends gcc libc6-dev binutils; } >/dev/null 2>&1 ;;
  esac
  echo "shim: $SHIM on $FLAVOUR"
  # the shell performs redirections itself, so it must be preloaded too
  exec env VFS_STAGE=1 LD_PRELOAD="$SHIM" VFS_MOUNTS=/vfs=/tmp/vfsstore sh "$0"
fi
fail() { echo "FAIL: $*"; exit 1; }
# in_order "log" "op" "op" …: each op appears in the log after the previous one
in_order() {
  rest="$1"; shift
  for op in "$@"; do
    case "$rest" in *"$op "*) rest="${rest#*"$op "}" ;; *) return 1 ;; esac
  done
}

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

# several mounts: the longest prefix wins and each maps to its own backing directory
env VFS_MOUNTS=/a=/tmp/store/a:/a/inner=/tmp/store/inner:/b=/tmp/store/b sh -euc '
fail() { echo "FAIL: $*"; exit 1; }
echo one > /a/f
echo two > /b/f
echo deep > /a/inner/x
[ "$(cat /a/f)" = "one" ] && [ "$(cat /b/f)" = "two" ] || fail "mounts: read back"
[ -f /tmp/store/a/f ] && [ -f /tmp/store/b/f ] || fail "mounts: each backing directory"
[ -f /tmp/store/inner/x ] && [ ! -e /tmp/store/a/inner/x ] || fail "mounts: nested mount wins for its subtree"
[ ! -e /vfs ] || fail "mounts: /vfs present although VFS_MOUNTS is set"
[ ! -e /ax ] && [ ! -e /bb ] || fail "mounts: lookalike prefix"
ln -s /b/f /a/lnk
[ "$(readlink /a/lnk)" = "/b/f" ] || fail "mounts: readlink across mounts: $(readlink /a/lnk)"
[ "$(cat /a/lnk)" = "two" ] || fail "mounts: symlink across mounts"
[ "$(cd /b && pwd)" = "/b" ] || fail "mounts: getcwd"
[ "$(cd /a/inner && pwd)" = "/a/inner" ] || fail "mounts: getcwd nested: $(cd /a/inner && pwd)"
mv /a/f /b/g
[ "$(cat /b/g)" = "one" ] && [ ! -e /a/f ] || fail "mounts: mv across mounts"
node -e "
const fs = require(\"fs\"), assert = require(\"assert\");
assert.strictEqual(fs.realpathSync(\"/a/inner/../inner/x\"), \"/a/inner/x\");
assert.deepStrictEqual(fs.readdirSync(\"/b\").sort(), [\"f\", \"g\"]);
" || fail "mounts: node"
' || fail "mounts"
echo "mounts: ok"

# supervisor socket tests: the package's 9P server, recording every adapter hook
rm -f /tmp/ops.log /tmp/vfs.ready
node /w/native/test-server.js &
SRVPID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do [ -f /tmp/vfs.ready ] && break; sleep 0.2; done
[ -f /tmp/vfs.ready ] || fail "9P test server did not start"

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
if [ "$FLAVOUR" = alpine ]; then
  # busybox's exact call sequence, pinned as before
  case "$LOG" in
    *"stat /vfs/tracked stat /vfs/tracked fetch /vfs/tracked open /vfs/tracked flush /vfs/tracked stat /vfs list /vfs stat /vfs mkdir /vfs/d2 stat /vfs stat /vfs/d2 rename /vfs/tracked /vfs/d2/tracked2 stat /vfs stat /vfs/d2 stat /vfs/d2/tracked2 stat /vfs/d2 unlink /vfs/d2/tracked2 stat /vfs unlink /vfs/d2 "*) ;;
    *) fail "log did not match: $LOG" ;;
  esac
else
  # GNU coreutils makes more calls; the operations must still arrive, in order
  in_order "$LOG" "open /vfs/tracked" "flush /vfs/tracked" "list /vfs" "mkdir /vfs/d2" \
    "rename /vfs/tracked /vfs/d2/tracked2" "unlink /vfs/d2/tracked2" "unlink /vfs/d2" ||
    fail "log out of order: $LOG"
fi

if grep -q "/tmp/notvfs" /tmp/ops.log 2>/dev/null; then
  fail "logged non-/vfs path"
fi

# a second mount reaches the supervisor under its own virtual path
rm -f /tmp/ops.log
env VFS_MOUNTS=/vfs=/tmp/vfsstore:/b=/tmp/store/b sh -c 'echo x > /b/reported' || fail "mounts: write to second mount with a supervisor"
grep -q "open /b/reported" /tmp/ops.log && grep -q "flush /b/reported" /tmp/ops.log ||
  fail "mounts: second mount not reported: $(tr '\n' ' ' < /tmp/ops.log)"

# advisory locks: a SQLite write transaction becomes lock -> flush -> unlock,
# a read transaction becomes revalidate, and a refused lock is SQLITE_BUSY.
rm -f /tmp/ops.log
node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/vfs/t.sqlite");
db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
db.exec("CREATE TABLE t (v TEXT)");
db.exec("INSERT INTO t VALUES (1)");
console.log(JSON.stringify(db.prepare("SELECT count(*) AS n FROM t").get()));
db.close();
' | grep -q '"n":1' || fail "sqlite round trip under the shim"
LOG=$(cat /tmp/ops.log | tr '\n' ' ')
for op in "lock /vfs/t.sqlite" "flush /vfs/t.sqlite" "unlock /vfs/t.sqlite" "revalidate /vfs/t.sqlite"; do
  case "$LOG" in *"$op "*) ;; *) fail "missing '$op' in: $LOG";; esac
done
case "$LOG" in
  *"lock /vfs/t.sqlite"*"unlock /vfs/t.sqlite"*) ;;
  *) fail "lock did not precede unlock: $LOG";;
esac
if node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/vfs/busy.sqlite");
db.exec("CREATE TABLE t (v TEXT)");
' 2>&1 | grep -qiE "locked|busy|EAGAIN"; then
  :
else
  fail "refused lock did not surface as SQLITE_BUSY"
fi
echo "locks: ok"

kill $SRVPID
wait $SRVPID 2>/dev/null || true

if ls /vfs 2>/dev/null; then
  fail "ls /vfs should fail with unreachable socket"
fi

unset VFS_SOCKET
echo "socket: ok"

echo "ALL OK"
