#!/bin/sh
# glibc older than the 2.34 floor (ADR 0003) must still start a preloaded process, and stat through
# the pre-2.33 __xstat names without crashing, inside and outside a mount.
#
#   sh native/legacy.sh x64|arm64
set -eu

arch="${1:-}"
case "$arch" in
  x64)   platform=linux/amd64 ;;
  arm64) platform=linux/arm64 ;;
  *) echo "usage: $0 x64|arm64" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
so="lib/linux-$arch/vfspreload.so"
[ -f "$root/$so" ] || { echo "$so missing: run native/build.sh $arch first" >&2; exit 2; }

# debian:11 is glibc 2.31, amazonlinux:2 (the AL2 Lambda base) is glibc 2.26
for image in debian:11 amazonlinux:2; do
  docker pull -q --platform "$platform" "$image" >/dev/null
  out=$(docker run --rm --platform "$platform" -v "$root:/w:ro" "$image" \
    env LD_PRELOAD="/w/$so" VFS_MOUNTS=/vfs=/tmp/vfsstore sh -c '
      ls / >/dev/null && [ -d /tmp ] &&
      echo legacy > /vfs/a && [ -f /vfs/a ] && [ -f /tmp/vfsstore/a ] && ls /vfs >/dev/null &&
      cat /vfs/a' 2>&1) ||
    { echo "legacy: $image: preloaded process failed: $out" >&2; exit 1; }
  [ "$out" = legacy ] || { echo "legacy: $image: unexpected output: $out" >&2; exit 1; }
  echo "legacy: $image ok"
done
