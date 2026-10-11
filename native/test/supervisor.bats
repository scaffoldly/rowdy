# With a supervisor (VFS_SOCKET): what reaches it, in what order, and how its refusals surface.

load helpers

setup_file() {
  compile socket -O2
  compile relative -O2
  start_supervisor
}

teardown_file() {
  stop_supervisor
  rm -rf /tmp/vfsstore/* /tmp/store
}

setup() {
  rm -f /tmp/ops.log
}

@test "a refused stat is EACCES" {
  run cat /vfs/denied
  [ "$status" -ne 0 ]
  [[ "$output" == *"Permission denied"* ]]
}

@test "a refused flush is EIO" {
  run node -e "fs.writeFileSync('/vfs/flushfail', 'x')"
  [[ "$output" == *"EIO"* ]]
  rm -f /vfs/flushfail
}

@test "the shell's and coreutils' operations arrive in order, and nothing outside the mount does" {
  sh -euc '
    touch /vfs/tracked
    ls /vfs >/dev/null
    mkdir /vfs/d2
    mv /vfs/tracked /vfs/d2/tracked2
    rm /vfs/d2/tracked2
    rmdir /vfs/d2
    echo x > /tmp/notvfs
  '
  if [ "$FLAVOUR" = alpine ]; then
    # busybox's exact call sequence
    [[ "$(ops)" == *"stat /vfs/tracked stat /vfs/tracked fetch /vfs/tracked open /vfs/tracked flush /vfs/tracked stat /vfs list /vfs stat /vfs mkdir /vfs/d2 stat /vfs stat /vfs/d2 rename /vfs/tracked /vfs/d2/tracked2 stat /vfs stat /vfs/d2 stat /vfs/d2/tracked2 stat /vfs/d2 unlink /vfs/d2/tracked2 stat /vfs unlink /vfs/d2 "* ]] ||
      { echo "log did not match: $(ops)" >&2; return 1; }
  else
    # GNU coreutils makes more calls; the operations must still arrive, in order
    in_order "open /vfs/tracked" "flush /vfs/tracked" "list /vfs" "mkdir /vfs/d2" \
      "rename /vfs/tracked /vfs/d2/tracked2" "unlink /vfs/d2/tracked2" "unlink /vfs/d2"
  fi
  rm -f /tmp/notvfs
  run grep -q /tmp/notvfs /tmp/ops.log
  [ "$status" -ne 0 ] || { echo "a path outside the mount reached the supervisor: $(ops)" >&2; return 1; }
}

@test "dup2 onto a descriptor open on a VFS file flushes it then, not at exit" {
  sh -c 'exec 3>/vfs/dupped; echo x >&3; exec 3>/dev/null; grep -q "flush /vfs/dupped" /tmp/ops.log' ||
    { echo "not flushed: $(ops)" >&2; return 1; }
  rm -f /vfs/dupped
}

@test "the supervisor socket sits above the descriptors programs pick and survives close and dup2" {
  run "$BATS_FILE_TMPDIR/socket"
  rm -f /vfs/sockprobe
  [ "$status" -eq 0 ] || { echo "rc=$status: $output" >&2; return 1; }
}

@test "paths relative to a directory descriptor or a cwd under the mount reach it by virtual path" {
  "$BATS_FILE_TMPDIR/relative"
  has_op "open /vfs/rel/made.txt" "flush /vfs/rel/made.txt" "mkdir /vfs/rel/sub" \
    "rename /vfs/rel/made.txt /vfs/rel/sub/moved.txt" "stat /vfs/rel/sub/moved.txt" \
    "unlink /vfs/rel/sub/moved.txt" "unlink /vfs/rel/sub" "open /vfs/rel/cwd.txt" "flush /vfs/rel/cwd.txt" \
    "mkdir /vfs/rel/cwdsub" "rename /vfs/rel/cwd.txt /vfs/rel/cwdsub/cwd2.txt" "unlink /vfs/rel/cwdsub/cwd2.txt" \
    "unlink /vfs/rel/cwdsub"
}

@test "rm -r deletes every object at the supervisor, by fts unlinkat or by full path" {
  mkdir -p /vfs/tree/a/b
  echo 1 >/vfs/tree/a/one
  echo 2 >/vfs/tree/a/b/two
  rm -f /tmp/ops.log
  rm -r /vfs/tree
  has_op "unlink /vfs/tree/a/b/two" "unlink /vfs/tree/a/one" "unlink /vfs/tree/a/b" "unlink /vfs/tree/a" "unlink /vfs/tree"
}

@test "a second mount reaches the supervisor under its own virtual path" {
  env VFS_MOUNTS=/vfs=/tmp/vfsstore:/b=/tmp/store/b sh -c 'echo x > /b/reported'
  has_op "open /b/reported" "flush /b/reported"
}

@test "a SQLite write transaction is lock, flush, unlock; a read is revalidate" {
  run node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/vfs/t.sqlite");
db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
db.exec("CREATE TABLE t (v TEXT)");
db.exec("INSERT INTO t VALUES (1)");
console.log(JSON.stringify(db.prepare("SELECT count(*) AS n FROM t").get()));
db.close();
'
  [[ "$output" == *'"n":1'* ]]
  has_op "lock /vfs/t.sqlite" "flush /vfs/t.sqlite" "unlock /vfs/t.sqlite" "revalidate /vfs/t.sqlite"
  in_order "lock /vfs/t.sqlite" "unlock /vfs/t.sqlite"
  rm -f /vfs/t.sqlite
}

@test "a lock the supervisor refuses is SQLITE_BUSY" {
  run node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/vfs/busy.sqlite");
db.exec("CREATE TABLE t (v TEXT)");
'
  echo "$output" | grep -qiE "locked|busy|EAGAIN"
  rm -f /vfs/busy.sqlite
}

@test "with the supervisor gone, /vfs is unreachable" {
  stop_supervisor
  run ls /vfs
  [ "$status" -ne 0 ]
}
