#!/bin/sh
# SQLite's own multi-process stress test (mptest) or benchmark (speedtest1) through the shim, built
# from a pinned SQLite release against glibc. Every mptest script must report no errors on /vfs, and
# on /s3 when S3_BUCKET is set; speedtest1 must complete everywhere, its timings reported as ratios,
# not gated. The report is printed, and appended to $GITHUB_STEP_SUMMARY when it is set.
#
#   sh native/sqlite.sh x64|arm64 mptest|speedtest1
set -eu

VERSION=3530400
YEAR=2026
SRC_SHA3=b834d474b9b393d85a9e3ee4cc11f1329e007e9376a424ee740796f5c4bda3a8
AMALGAMATION_SHA3=628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e
SPEEDTEST_SIZE=10

if [ ! -f /.dockerenv ]; then
  arch="${1:-}" suite="${2:-}"
  case "$arch" in
    x64)   platform=linux/amd64 ;;
    arm64) platform=linux/arm64 ;;
    *) echo "usage: $0 x64|arm64 mptest|speedtest1" >&2; exit 2 ;;
  esac
  case "$suite" in
    mptest|speedtest1) ;;
    *) echo "usage: $0 x64|arm64 mptest|speedtest1" >&2; exit 2 ;;
  esac
  root="$(cd "$(dirname "$0")/.." && pwd)"
  [ -f "$root/dist/index.js" ] || { echo "dist/index.js missing: run yarn build first (the supervisor is the package's 9P server)" >&2; exit 2; }
  [ -f "$root/lib/linux-$arch/vfspreload.so" ] || { echo "lib/linux-$arch/vfspreload.so missing: run native/build.sh $arch first" >&2; exit 2; }

  cache="$root/.sqlite"
  mkdir -p "$cache"
  for pinned in "sqlite-src-$VERSION.zip $SRC_SHA3" "sqlite-amalgamation-$VERSION.zip $AMALGAMATION_SHA3"; do
    set -- $pinned
    [ -f "$cache/$1" ] || curl -fsSL -o "$cache/$1" "https://www.sqlite.org/$YEAR/$1"
    [ "$(openssl dgst -sha3-256 -r "$cache/$1" | cut -d' ' -f1)" = "$2" ] ||
      { echo "sqlite: $1 does not match its pinned SHA3-256" >&2; exit 1; }
  done
  rm -rf "$cache/src" "$cache/out"
  mkdir -p "$cache/src" "$cache/out"
  unzip -qo "$cache/sqlite-src-$VERSION.zip" "sqlite-src-$VERSION/mptest/*" "sqlite-src-$VERSION/test/speedtest1.c" -d "$cache/src"
  unzip -qjo "$cache/sqlite-amalgamation-$VERSION.zip" "*/sqlite3.c" "*/sqlite3.h" -d "$cache/src"

  rc=0
  docker run --rm --platform "$platform" -e ARCH="$arch" -e SUITE="$suite" -e SHIM="/w/lib/linux-$arch/vfspreload.so" \
    -e S3_BUCKET -e S3_PREFIX -e AWS_REGION -e AWS_DEFAULT_REGION \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
    -v "$root:/w:ro" -v "$cache/out:/out" \
    node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 \
    sh /w/native/sqlite.sh || rc=$?
  if [ -f "$cache/out/summary.md" ]; then
    cat "$cache/out/summary.md"
    [ -z "${GITHUB_STEP_SUMMARY:-}" ] || cat "$cache/out/summary.md" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit "$rc"
fi

# ---- in the container ----------------------------------------------------------------------------
MPTEST_TIMEOUT=900
# The scripts run on /s3 too. Every commit there is a lease, an upload and a release in S3, so the
# five-writer contention script alone takes minutes; the others run on /vfs only.
S3_SCRIPTS="multiwrite01"
say() { echo "[$(date +%H:%M:%S)] $*"; }
say "installing gcc"
{ apt-get -qq update && apt-get -qq install -y --no-install-recommends gcc libc6-dev; } >/dev/null 2>&1
say "compiling SQLite $VERSION and $SUITE"
src=/w/.sqlite/src
b=/tmp/sq
mkdir -p "$b" /tmp/speed
cp -r "$src/sqlite-src-$VERSION/mptest" "$b/mptest"
# mptest's --wait gives up after 10 s, sized for a local disk; then every later check fails on rows
# not yet written. An hour each, so a slow store is slow, not wrong (the step's timeout still bounds it).
sed -i 's/^--wait all$/--wait all 3600000/; s/^--wait \([0-9][0-9]*\)$/--wait \1 3600000/' \
  "$b"/mptest/*.test "$b"/mptest/*.subtest
# R-Tree for speedtest1's rtree testset; mptest is indifferent
opts="-O2 -DSQLITE_THREADSAFE=0 -DHAVE_USLEEP -DSQLITE_ENABLE_RTREE -I$src"
gcc $opts -c "$src/sqlite3.c" -o "$b/sqlite3.o"
if [ "$SUITE" = mptest ]; then
  gcc $opts "$b/mptest/mptest.c" "$b/sqlite3.o" -o "$b/mptest/mptest" -lm -ldl
else
  gcc $opts "$src/sqlite-src-$VERSION/test/speedtest1.c" "$b/sqlite3.o" -o "$b/speedtest1" -lm -ldl -lpthread
fi

say "starting the supervisor (mounts: /vfs${S3_BUCKET:+ /s3})"
node /w/native/sqlite-server.js &
srv=$!
for i in $(seq 1 50); do [ -f /tmp/vfs.ready ] && break; sleep 0.2; done
[ -f /tmp/vfs.ready ] || { echo "sqlite: supervisor did not start" >&2; exit 1; }

mounts=/vfs
[ -z "${S3_BUCKET:-}" ] || mounts="/vfs /s3"
release=$(echo "$VERSION" | awk '{ printf "%d.%d.%d", substr($0, 1, 1), substr($0, 2, 2), substr($0, 4, 2) }')

# the processes below, and the clients mptest starts through system(), are preloaded
export LD_PRELOAD="$SHIM" VFS_SOCKET=/tmp/rowdy/vfs.sock
export VFS_MOUNTS="/vfs=/tmp/vfsstore${S3_BUCKET:+:/s3=/tmp/s3store}"

# ---- mptest: every script on every mount ----
failed=0 passed=0 ran=0
rows=/tmp/mptest.rows logs=/tmp/mptest.logs
: > "$rows"
: > "$logs"
describe() {
  case "$1" in
    config01) echo "5 clients, mixed journal modes (PERSIST, TRUNCATE, MEMORY, OFF) and mmap, then multiwrite01" ;;
    config02) echo "5 clients on 512-byte pages, mmap from 0 to 256 MiB, then multiwrite01" ;;
    crash01) echo "clients exit mid-transaction, leaving hot journals the others must roll back" ;;
    multiwrite01) echo "5 clients writing and updating one database at once, each in its own table" ;;
  esac
}
cd "$b/mptest"
[ "$SUITE" = mptest ] && scripts="config01 config02 crash01 multiwrite01" || scripts=
for script in $scripts; do
  row="| \`$script\` | $(describe "$script") |"
  for m in $mounts; do
    if [ "$m" = /s3 ]; then
      case " $S3_SCRIPTS " in
        *" $script "*) ;;
        *) row="$row – |"; continue ;;
      esac
    fi
    db="$m/mp-$script.db"
    log="/tmp/mp-$script-${m#/}.log"
    start=$(date +%s)
    status=0
    : > /tmp/s3-adapter.log
    say "mptest $script on $m ..."
    timeout "$MPTEST_TIMEOUT" ./mptest "$db" --quiet --timeout 30000 "$script.test" > "$log" 2>&1 || status=$?
    took=$(( $(date +%s) - start ))
    ran=$((ran + 1))
    if [ "$status" -eq 0 ]; then
      passed=$((passed + 1))
      row="$row ✅ ${took}s |"
      say "mptest $script on $m: ok, ${took}s"
    else
      failed=1
      summary=$(grep -h 'Summary:' "$log" | tail -1)
      [ "$status" -ne 124 ] || summary="timed out after ${MPTEST_TIMEOUT}s"
      say "mptest $script on $m: FAILED after ${took}s (${summary:-exit $status})"
      row="$row ❌ ${summary:-exit $status} |"
      {
        echo "<details><summary>❌ <code>$script</code> on <code>$m</code>: first and last errors</summary>"
        echo
        echo '```'
        grep -m 30 'ERROR' "$log" || :
        echo '...'
        tail -30 "$log"
        echo '```'
        if [ "$m" = /s3 ] && [ -s /tmp/s3-adapter.log ]; then
          echo
          echo "Adapter decisions (everything but per-request trace), then the last 60 lines:"
          echo
          echo '```'
          grep -v '"duration"' /tmp/s3-adapter.log | head -60 || :
          echo '...'
          tail -60 /tmp/s3-adapter.log
          echo '```'
        fi
        echo
        echo "</details>"
        echo
      } >> "$logs"
      echo "---- mptest $script on $m" >&2
      grep -m 30 'ERROR' "$log" >&2 || :
      [ "$m" != /s3 ] || { echo "---- adapter" >&2; tail -200 /tmp/s3-adapter.log >&2; }
    fi
    rm -f "$db" "$db-journal" "$db-wal" "$db-shm"
  done
  echo "$row" >> "$rows"
done

# ---- speedtest1: /tmp without and with the preload, then every mount ----
places=
speed() { # speed KEY LABEL DIR [no]
  db="$3/speed.db"
  run=
  [ "${4:-}" != no ] || run="env -u LD_PRELOAD"
  say "speedtest1 on $2 ..."
  status=0
  $run timeout "$MPTEST_TIMEOUT" "$b/speedtest1" --size "$SPEEDTEST_SIZE" "$db" > "/tmp/speed/$1.log" 2>&1 || status=$?
  $run rm -f "$db" "$db-journal" "$db-wal"
  # one "NNN - name....... 0.071s" line per test (numbers repeat across testsets), then a TOTAL line
  awk '/^ *[0-9]+ - / { n = $1; t = $NF; sub(/s$/, "", t); sub(/^ *[0-9]+ - /, ""); sub(/[. ]+[0-9.]+s$/, ""); print n " " $0 "\t" t }' \
    "/tmp/speed/$1.log" > "/tmp/speed/$1.tests"
  awk '/TOTAL/ { t = $NF; sub(/s$/, "", t); print t }' "/tmp/speed/$1.log" > "/tmp/speed/$1.total"
  if [ "$status" -ne 0 ] || [ ! -s "/tmp/speed/$1.total" ]; then
    failed=1
    reason=$(grep -m1 -iE 'error|fail' "/tmp/speed/$1.log" || :)
    [ "$status" -ne 124 ] || reason="timed out after ${MPTEST_TIMEOUT}s"
    echo "❌ ${reason:-exit $status}" > "/tmp/speed/$1.total"
    {
      echo "<details><summary>❌ speedtest1 on <code>$2</code>: last 30 lines</summary>"
      echo
      echo '```'
      tail -30 "/tmp/speed/$1.log"
      echo '```'
      echo
      echo "</details>"
      echo
    } >> "$logs"
    say "speedtest1 on $2: FAILED (${reason:-exit $status})"
    tail -30 "/tmp/speed/$1.log" >&2
  else
    say "speedtest1 on $2: $(cat "/tmp/speed/$1.total")s"
  fi
  echo "$2" > "/tmp/speed/$1.label"
  places="$places $1"
}
if [ "$SUITE" = speedtest1 ]; then
  speed tmp-plain "/tmp, no preload" /tmp no
  speed tmp "/tmp, preloaded" /tmp
  for m in $mounts; do speed "${m#/}" "$m" "$m"; done
fi

ratio() { awk -v t="$1" -v b="$2" 'BEGIN { if (t + 0 > 0 && b + 0 > 0) printf "%.2f×", t / b; else print "–" }'; }
base=$(cat /tmp/speed/tmp-plain.total 2>/dev/null || :)

# ---- the report ----
out=/out/summary.md
mpcols="| /vfs |"
mpsep="---|"
[ -z "${S3_BUCKET:-}" ] || { mpcols="| /vfs | /s3 |"; mpsep="---|---|"; }
{
  if [ "$failed" -eq 0 ]; then
    echo "### ✅ SQLite $release $SUITE through the shim · $ARCH"
  else
    echo "### ❌ SQLite $release $SUITE through the shim · $ARCH"
  fi
  echo
  [ -n "${S3_BUCKET:-}" ] || echo "_/s3 skipped: no S3_BUCKET._"
  if [ "$SUITE" = mptest ]; then
    echo "**mptest** $passed/$ran passed: SQLite's multi-process stress test, each client a separate preloaded process on one database."
    [ -z "${S3_BUCKET:-}" ] || echo "_On /s3 only $S3_SCRIPTS runs: every commit there is a lease, an upload and a release in S3._"
    echo
    echo "| script | what it exercises $mpcols"
    echo "|---|---|$mpsep"
    cat "$rows"
    echo
    cat "$logs"
  else
    echo "**speedtest1** \`--size $SPEEDTEST_SIZE\`, every testset: SQLite's benchmark workload. Must complete; timings reported, not gated."
    echo
    echo "| where | total | vs /tmp, no preload |"
    echo "|---|---:|---:|"
    for k in $places; do
      t=$(cat "/tmp/speed/$k.total")
      case "$t" in ❌*) echo "| $(cat "/tmp/speed/$k.label") | $t | – |" ;; *) echo "| $(cat "/tmp/speed/$k.label") | ${t}s | $(ratio "$t" "$base") |" ;; esac
    done
    echo
    cat "$logs"
    echo "<details><summary>speedtest1 per test, seconds</summary>"
  echo
  printf '| test |'
  for k in $places; do printf ' %s |' "$(cat "/tmp/speed/$k.label")"; done
  echo
  printf '|---|'
  for k in $places; do printf -- '---:|'; done
  echo
  awk -F '\t' -v places="$places" '
    BEGIN { n = split(places, p, " ") }
    FNR == 1 { f++ }
    { if (!($1 in name)) { order[++rows] = $1; name[$1] = $2 } t[$1, f] = $3 }
    END {
      for (r = 1; r <= rows; r++) {
        id = order[r]
        line = "| " id " " name[id] " |"
        for (i = 1; i <= n; i++) line = line " " ((id, i) in t ? t[id, i] : "") " |"
        print line
      }
    }' $(for k in $places; do echo "/tmp/speed/$k.tests"; done)
    echo
    echo "</details>"
  fi
} > "$out"

kill -TERM "$srv"
wait "$srv" || failed=1
exit "$failed"
