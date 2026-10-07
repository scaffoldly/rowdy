#!/bin/sh
# Compile native/vfspreload.c for one architecture into lib/linux-<arch>/vfspreload.so, then gate
# it with native/symbols.sh. One object serves musl and glibc (ADR 0003): it is built against glibc
# 2.36 on a pinned Debian 12, linked only to libc.so.6, which musl's loader resolves to itself.
#
#   sh native/build.sh x64
#   sh native/build.sh arm64
set -eu

arch="${1:-}"
case "$arch" in
  x64)   platform=linux/amd64 ;;
  arm64) platform=linux/arm64 ;;
  *) echo "usage: $0 x64|arm64" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
out="lib/linux-$arch"
mkdir -p "$root/$out"

# DEVNOTE: initial-exec TLS keeps ld-linux out of DT_NEEDED (no __tls_get_addr); no stack protector
# or fortify keeps glibc-only __*_chk calls out of the object. Both would stop musl from loading it.
docker run --rm --platform "$platform" -v "$root:/w" -w /w \
  debian:12@sha256:2c037a04925515fdd6ea85ea14a682d0e79931f5e9f5d07b6dbfc6ba12f9e858 sh -euc "
  apt-get -qq update >/dev/null
  apt-get -qq install -y --no-install-recommends gcc libc6-dev >/dev/null
  gcc -O2 -s -shared -fPIC -Wall -Wextra -Werror -ftls-model=initial-exec -fno-stack-protector -U_FORTIFY_SOURCE \
    native/vfspreload.c -o $out/vfspreload.so
"
echo "built $out/vfspreload.so"
sh "$root/native/symbols.sh" "$arch"
