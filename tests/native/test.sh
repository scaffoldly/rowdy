#!/bin/sh
# Integration tests for the shim built by native/build.sh: tests/native/test/*.bats, run with bats-core
# inside the image under the shim's LD_PRELOAD (VFS_MOUNTS=/vfs=/tmp/vfsstore). They drive it through
# the image's own shell and coreutils (busybox on alpine, GNU on debian), node (libuv), C callers,
# several mounts and the package's 9P server. tests/native/unit.sh tests the headers' logic directly.
#
#   sh tests/native/test.sh x64|arm64 alpine|debian [bats args...]
set -eu

if [ ! -f /.dockerenv ]; then
  arch="${1:-}"; flavour="${2:-}"
  case "$arch" in
    x64)   platform=linux/amd64 ;;
    arm64) platform=linux/arm64 ;;
    *) echo "usage: $0 x64|arm64 alpine|debian [bats args...]" >&2; exit 2 ;;
  esac
  case "$flavour" in
    alpine) image=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 ;;
    debian) image=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 ;;
    *) echo "usage: $0 x64|arm64 alpine|debian [bats args...]" >&2; exit 2 ;;
  esac
  shift 2
  root="$(cd "$(dirname "$0")/../.." && pwd)"
  [ -f "$root/dist/index.js" ] || { echo "dist/index.js missing: run yarn build first (the test supervisor is the package's 9P server)" >&2; exit 2; }
  [ -f "$root/lib/linux-$arch/vfspreload.so" ] || { echo "lib/linux-$arch/vfspreload.so missing: run native/build.sh $arch first" >&2; exit 2; }
  exec docker run --rm --platform "$platform" -e FLAVOUR="$flavour" -e SHIM="/w/lib/linux-$arch/vfspreload.so" \
    -v "$root:/w:ro" "$image" sh /w/tests/native/test.sh "$@"
fi

# A C toolchain for the test callers and bats-core to run the suite; the shim under test is the
# built artifact.
case "$FLAVOUR" in
  alpine) apk add --no-cache gcc musl-dev linux-headers bats >/dev/null 2>&1 ;;
  debian) { apt-get -qq update && apt-get -qq install -y --no-install-recommends gcc libc6-dev binutils bats; } >/dev/null 2>&1 ;;
esac
echo "shim: $SHIM on $FLAVOUR, $(bats --version)"
# bats itself is preloaded too: the shell performs redirections itself
exec env LD_PRELOAD="$SHIM" VFS_MOUNTS=/vfs=/tmp/vfsstore bats "$@" /w/tests/native/test
