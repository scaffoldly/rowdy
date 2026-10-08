#!/bin/sh
# SQLite's own multi-process stress test (mptest) and benchmark (speedtest1) through the shim, built
# from a pinned SQLite release against glibc. Every mptest script must report no errors on /vfs, and
# on /s3 when S3_BUCKET is set. speedtest1's totals are reported as ratios, not gated. The results
# go to $GITHUB_STEP_SUMMARY when it is set.
#
#   sh native/sqlite.sh x64|arm64
set -eu

VERSION=3530400
YEAR=2026
SRC_SHA3=b834d474b9b393d85a9e3ee4cc11f1329e007e9376a424ee740796f5c4bda3a8
AMALGAMATION_SHA3=628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e
SPEEDTEST_SIZE=10

if [ ! -f /.dockerenv ]; then
  arch="${1:-}"
  case "$arch" in
    x64)   platform=linux/amd64 ;;
    arm64) platform=linux/arm64 ;;
    *) echo "usage: $0 x64|arm64" >&2; exit 2 ;;
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
  docker run --rm --platform "$platform" -e ARCH="$arch" -e SHIM="/w/lib/linux-$arch/vfspreload.so" \
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
{ apt-get -qq update && apt-get -qq install -y --no-install-recommends gcc libc6-dev; } >/dev/null 2>&1
src=/w/.sqlite/src
b=/tmp/sq
mkdir -p "$b"
cp -r "$src/sqlite-src-$VERSION/mptest" "$b/mptest"
opts="-O2 -DSQLITE_THREADSAFE=0 -DHAVE_USLEEP -DSQLITE_OMIT_LOAD_EXTENSION -I$src"
gcc $opts -c "$src/sqlite3.c" -o "$b/sqlite3.o"
gcc $opts "$b/mptest/mptest.c" "$b/sqlite3.o" -o "$b/mptest/mptest" -lm
gcc $opts "$src/sqlite-src-$VERSION/test/speedtest1.c" "$b/sqlite3.o" -o "$b/speedtest1" -lm -lpthread

node /w/native/sqlite-server.js &
srv=$!
for i in $(seq 1 50); do [ -f /tmp/vfs.ready ] && break; sleep 0.2; done
[ -f /tmp/vfs.ready ] || { echo "sqlite: supervisor did not start" >&2; exit 1; }

mounts=/vfs
[ -z "${S3_BUCKET:-}" ] || mounts="/vfs /s3"
s3col() { [ -n "${S3_BUCKET:-}" ] && printf ' %s |' "$1" || :; }

failed=0
out=/out/summary.md
{
  echo "### SQLite $VERSION through the shim ($ARCH)"
  echo
  [ -n "${S3_BUCKET:-}" ] || echo "_/s3 skipped: no S3_BUCKET_"
  echo
  printf '| mptest | /vfs |'; s3col /s3; echo
  printf '|---|---|'; s3col ---; echo
} > "$out"

# the processes below, and the clients mptest starts through system(), are preloaded
export LD_PRELOAD="$SHIM" VFS_SOCKET=/tmp/rowdy/vfs.sock
export VFS_MOUNTS="/vfs=/tmp/vfsstore${S3_BUCKET:+:/s3=/tmp/s3store}"

cd "$b/mptest"
for script in config01 config02 crash01 multiwrite01; do
  row="| $script |"
  for m in $mounts; do
    db="$m/mp-$script.db"
    log="/tmp/mp-$script-${m#/}.log"
    start=$(date +%s)
    status=0
    timeout 900 ./mptest "$db" --quiet --timeout 30000 "$script.test" > "$log" 2>&1 || status=$?
    if [ "$status" -eq 0 ]; then
      cell="ok, $(( $(date +%s) - start ))s"
    else
      summary=$(grep -h 'Summary:' "$log" | tail -1)
      cell="**FAIL** (${summary:-exit $status})"
      failed=1
      echo "---- mptest $script on $m" >&2
      tail -40 "$log" >&2
    fi
    row="$row $cell |"
    rm -f "$db" "$db-journal" "$db-wal" "$db-shm"
  done
  echo "$row" >> "$out"
done

{
  echo
  echo "| speedtest1 --size $SPEEDTEST_SIZE | total | vs /tmp, no preload |"
  echo "|---|---|---|"
} >> "$out"
base=
# speed LABEL DIR [no]: one speedtest1 run on DIR, preloaded unless the third argument is "no"
speed() {
  db="$2/speed.db"
  run=
  [ "${3:-}" != no ] || run="env -u LD_PRELOAD"
  $run "$b/speedtest1" --size "$SPEEDTEST_SIZE" "$db" > /tmp/speed.log 2>&1 || failed=1
  $run rm -f "$db" "$db-journal" "$db-wal"
  total=$(awk '/TOTAL/ { sub(/s$/, "", $NF); print $NF }' /tmp/speed.log)
  [ -n "$total" ] || { total=?; failed=1; tail -20 /tmp/speed.log >&2; }
  [ -n "$base" ] || base=$total
  ratio=$(awk -v t="$total" -v b="$base" 'BEGIN { if (t + 0 > 0 && b + 0 > 0) printf "%.2fx", t / b; else print "?" }')
  echo "| $1 | ${total}s | $ratio |" >> "$out"
}
speed "/tmp, no preload" /tmp no
speed "/tmp, preloaded" /tmp
for m in $mounts; do speed "$m" "$m"; done

kill -TERM "$srv"
wait "$srv" || failed=1
exit "$failed"
