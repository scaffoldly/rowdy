# Shared by native/test/*.bats. The suite runs inside the image under the shim's LD_PRELOAD with
# VFS_MOUNTS=/vfs=/tmp/vfsstore (native/test.sh), so bats itself and every command a test runs are
# preloaded. A test that exercises the image's own shell runs it as `sh -c`.

bats_require_minimum_version 1.5.0   # run --separate-stderr

# compile <name> [gcc args...]: native/test/c/<name>.c into $BATS_FILE_TMPDIR/<name>
compile() {
  local name=$1
  shift
  gcc "$@" "$BATS_TEST_DIRNAME/c/$name.c" -o "$BATS_FILE_TMPDIR/$name"
}

# The supervisor: the package's own 9P server, which records every adapter hook in /tmp/ops.log
# and refuses a few paths (denied, flushfail, busy) to exercise the shim's error paths.
start_supervisor() {
  rm -f /tmp/ops.log /tmp/vfs.ready
  node /w/native/test-server.js 3>&- &   # bats waits on fd 3: a background job must not hold it
  echo $! >"$BATS_FILE_TMPDIR/supervisor.pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -f /tmp/vfs.ready ] && break
    sleep 0.2
  done
  [ -f /tmp/vfs.ready ] || { echo "9P test server did not start" >&2; return 1; }
  export VFS_SOCKET=/tmp/vfs.sock
}

stop_supervisor() {
  local pid
  pid=$(cat "$BATS_FILE_TMPDIR/supervisor.pid" 2>/dev/null) || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

# The supervisor's log on one line, each entry followed by a space.
ops() { tr '\n' ' ' </tmp/ops.log; }

# has_op <op>...: the log has each op
has_op() {
  local log op
  log=$(ops)
  for op in "$@"; do
    [[ "$log" == *"$op "* ]] || { echo "supervisor never saw '$op' in: $log" >&2; return 1; }
  done
}

# in_order <op>...: each op appears in the log after the previous one
in_order() {
  local rest op
  rest=$(ops)
  for op in "$@"; do
    [[ "$rest" == *"$op "* ]] || { echo "'$op' missing or out of order in: $(ops)" >&2; return 1; }
    rest=${rest#*"$op "}
  done
}
