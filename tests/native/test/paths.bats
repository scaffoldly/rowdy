# Path operations under /vfs from the image's shell and coreutils (busybox on alpine, GNU on
# debian), node (libuv) and C callers, without a supervisor.

load helpers

setup_file() {
  compile fopen
  if [ "$FLAVOUR" = debian ]; then
    # fortified, so the __*_2 / __*_chk entry points are the ones actually called
    compile hooks -O2 -D_FORTIFY_SOURCE=2
  else
    compile hooks -O2
  fi
}

@test "shell and coreutils: create, read, move, copy, chmod, truncate, links, cwd, remove" {
  sh -euc '
    ls /vfs >/dev/null
    echo hi > /vfs/a
    [ "$(cat /vfs/a)" = "hi" ]
    [ -f /tmp/vfsstore/a ]                     # persisted to the backing directory
    mkdir /vfs/d
    mv /vfs/a /vfs/d/b
    [ "$(cat /vfs/d/b)" = "hi" ]
    cp /vfs/d/b /vfs/d/c
    touch /vfs/d/c
    chmod 600 /vfs/d/c
    [ "$(stat -c %a /vfs/d/c)" = "600" ]
    truncate -s 0 /vfs/d/c
    [ ! -s /vfs/d/c ]
    ln -s /vfs/d/b /vfs/lnk
    [ "$(cat /vfs/lnk)" = "hi" ]
    [ "$(readlink /vfs/lnk)" = "/vfs/d/b" ]    # translated back
    ln /vfs/d/b /vfs/hard
    [ "$(cat /vfs/hard)" = "hi" ]
    [ "$(cd /vfs/d && pwd)" = "/vfs/d" ]
    [ "$(cd /vfs/d && cat b)" = "hi" ]         # relative after chdir
    [ "$(ls /vfs | sort | tr "\n" " ")" = "d hard lnk " ]
    rm /vfs/hard /vfs/lnk /vfs/d/c /vfs/d/b
    rmdir /vfs/d
    [ -z "$(ls /vfs)" ]
  '
}

@test "node (libuv): statx via raw syscall, openat, scandir, realpath, mkdtemp, rename, symlink, chdir" {
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
'
}

@test "C: fopen, fgets, remove" {
  "$BATS_FILE_TMPDIR/fopen"
}

@test "C: the glibc entry points and the newer hooks" {
  if [ "$FLAVOUR" = debian ]; then
    for sym in __open_2 __openat_2 __open64_2 __realpath_chk __getcwd_chk __readlink_chk __readlinkat_chk fcntl64 scandirat64; do
      nm -D "$BATS_FILE_TMPDIR/hooks" | grep -q " $sym" || { echo "the test caller does not import $sym" >&2; return 1; }
    done
  fi
  run "$BATS_FILE_TMPDIR/hooks"
  rm -rf /vfs/h.txt /vfs/c.txt /vfs/gl /vfs/g.txt /vfs/true /vfs/bin
  [ "$status" -eq 0 ] || { echo "rc=$status: $output" >&2; return 1; }
}

@test "node's stat and lock calls, imported from an older glibc, bind to the shim" {
  [ "$FLAVOUR" = debian ] || skip "glibc only"
  local checked=0
  for sym in __xstat64 __lxstat64 fcntl64; do
    nm -D --undefined-only "$(command -v node)" | grep -qE " $sym(@|\$)" || continue
    checked=1
    LD_DEBUG=bindings node -e 0 2>&1 | grep -q "binding file node .* to $SHIM .*\`$sym'" ||
      { echo "node's $sym does not bind to the shim" >&2; return 1; }
  done
  [ "$checked" = 1 ] || skip "node imports none of them"
}

@test "a relative path that climbs into the mount from outside it reaches the mount" {
  run --separate-stderr sh -euc '
    cd /tmp
    node -e "require(\"fs\").writeFileSync(\"../vfs/climbed.txt\", \"up\")"
    ln -s climbed.txt ../vfs/climbed-link
  '
  echo "$output $stderr"
  [ "$status" -eq 0 ]
  [ "$(cat /tmp/vfsstore/climbed.txt)" = up ]
  [ "$(readlink /tmp/vfsstore/climbed-link)" = climbed.txt ]
  rm -f /vfs/climbed.txt /vfs/climbed-link
}

@test "node's fs.watch sees a change under the mount (inotify on the translated path)" {
  mkdir -p /vfs/watched
  run --separate-stderr node -e '
const fs = require("fs");
const watcher = fs.watch("/vfs/watched", (event, name) => {
  console.log(event, name);
  watcher.close();
  process.exit(0);
});
setTimeout(() => fs.writeFileSync("/vfs/watched/new.txt", "x"), 100);
setTimeout(() => { console.error("no event"); process.exit(1); }, 5000);
'
  echo "$output $stderr"
  [ "$status" -eq 0 ]
  [[ "$output" == *"new.txt"* ]]
  rm -rf /vfs/watched
}

@test "paths outside every mount are left alone" {
  echo outside >/tmp/outside.a
  mv /tmp/outside.a /tmp/outside.b
  [ "$(cat /tmp/outside.b)" = outside ]
  rm /tmp/outside.b
}

@test "without the preload, /vfs does not exist and the backing directory does" {
  env -u LD_PRELOAD sh -c '[ ! -e /vfs ]'
  env -u LD_PRELOAD sh -c '[ -d /tmp/vfsstore ]'
}
