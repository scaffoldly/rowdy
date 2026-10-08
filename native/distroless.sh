#!/bin/sh
# Run native/test-distroless.js in the distroless node image, as its nonroot user.
#
#   sh native/distroless.sh x64|arm64
set -eu

arch="${1:-}"
case "$arch" in
  x64)   platform=linux/amd64 ;;
  arm64) platform=linux/arm64 ;;
  *) echo "usage: $0 x64|arm64" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$root/dist/index.js" ] || { echo "dist/index.js missing: run yarn build first (the test supervisor is the package's 9P server)" >&2; exit 2; }
[ -f "$root/lib/linux-$arch/vfspreload.so" ] || { echo "lib/linux-$arch/vfspreload.so missing: run native/build.sh $arch first" >&2; exit 2; }

exec docker run --rm --platform "$platform" --user 65532:65532 -e SHIM="/w/lib/linux-$arch/vfspreload.so" \
  -v "$root:/w:ro" \
  gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e \
  /w/native/test-distroless.js
