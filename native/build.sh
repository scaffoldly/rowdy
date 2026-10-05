#!/bin/sh
# Compile native/vfspreload.c against musl for one architecture, into
# lib/linux-<arch>/vfspreload.so. Runs gcc inside alpine so the build is the
# same on a laptop, a native CI runner, or under QEMU.
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

docker run --rm --platform "$platform" -v "$root:/w" -w /w alpine:3 sh -euc "
  apk add --no-cache gcc musl-dev linux-headers >/dev/null
  gcc -O2 -s -shared -fPIC -Wall -Wextra -Werror native/vfspreload.c -o $out/vfspreload.so
"
echo "built $out/vfspreload.so"
