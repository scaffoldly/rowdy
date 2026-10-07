#!/bin/sh
# Gate for the shim (ADR 0003): the object is built against glibc but must also load under musl,
# whose loader refuses to start a process whose preload has an unresolved symbol.
#
#   sh native/symbols.sh x64|arm64 [path]
#
# Fails unless DT_NEEDED is exactly libc.so.6 and libdl.so.2, every strong undefined symbol is
# exported by musl, and no GLIBC_ version newer than 2.17 is required: older glibc must still start a
# preloaded process (native/legacy.sh), even below the 2.34 floor where volumes are supported.
set -eu

arch="${1:-}"
case "$arch" in
  x64)   platform=linux/amd64 ;;
  arm64) platform=linux/arm64 ;;
  *) echo "usage: $0 x64|arm64 [path]" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
so="${2:-lib/linux-$arch/vfspreload.so}"
[ -f "$root/$so" ] || { echo "$so missing: run native/build.sh $arch first" >&2; exit 2; }

docker run --rm --platform "$platform" -v "$root:/w:ro" -w /w \
  alpine:3@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 sh -euc '
  apk add --no-cache binutils >/dev/null
  so="$1"
  musl=$(ls /lib/ld-musl-*.so.1)

  needed=$(objdump -p "$so" | awk "/NEEDED/ {print \$2}" | sort | tr "\n" " ")
  [ "$needed" = "libc.so.6 libdl.so.2 " ] || { echo "symbols: DT_NEEDED must be exactly libc.so.6 libdl.so.2, got: $needed" >&2; exit 1; }

  nm -D --defined-only "$musl" | awk "{print \$NF}" | sort -u > /tmp/musl
  nm -D --undefined-only "$so" | awk "\$1 == \"U\" {sub(/@.*/, \"\", \$2); print \$2}" | sort -u > /tmp/need
  missing=$(comm -23 /tmp/need /tmp/musl | tr "\n" " ")
  [ -z "$missing" ] || { echo "symbols: not exported by musl: $missing" >&2; exit 1; }

  newest=$(objdump -T "$so" | grep -oE "GLIBC_[0-9]+\.[0-9]+" | sort -uV | tail -1)
  [ "$(printf "%s\nGLIBC_2.17\n" "$newest" | sort -V | tail -1)" = "GLIBC_2.17" ] ||
    { echo "symbols: requires $newest, newer than GLIBC_2.17" >&2; exit 1; }

  echo "symbols: ok ($so needs libc.so.6 libdl.so.2, $(wc -l < /tmp/need | tr -d " ") symbols, newest $newest)"
' sh "$so"
