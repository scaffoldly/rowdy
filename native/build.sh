#!/bin/sh
# Compile native/vfspreload.c for one architecture into lib/linux-<arch>/vfspreload.so, then gate
# it with native/symbols.sh. One object serves musl and glibc (ADR 0003): it is built against glibc
# 2.36 on a pinned Debian 12 with its toolchain from a pinned snapshot (native/apt-snapshot.sh),
# linked only to libc.so.6, which musl's loader resolves to itself.
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
# dlsym is bound at its original version and attributed to libdl.so.2, exactly as in binaries built
# against glibc < 2.34: there libdl.so.2 defines it (older loaders insist the version come from the
# named file); 2.34+ keeps satisfying that reference from libc.so.6; musl resolves libdl to itself.
# A stub libdl.so.2 exporting only that version is linked so the reference records that file.
docker run --rm --platform "$platform" -v "$root:/w" -w /w \
  debian:12@sha256:2c037a04925515fdd6ea85ea14a682d0e79931f5e9f5d07b6dbfc6ba12f9e858 sh -euc "
  sh /w/native/apt-snapshot.sh
  apt-get -qq update >/dev/null
  apt-get -qq install -y --no-install-recommends gcc libc6-dev >/dev/null
  case \$(uname -m) in x86_64) dlver=GLIBC_2.2.5 ;; *) dlver=GLIBC_2.17 ;; esac
  mkdir -p /tmp/stub
  echo 'void *dlsym(void *h, const char *s) { (void)h; (void)s; return 0; }' > /tmp/stub/dl.c
  echo \"\$dlver { global: dlsym; local: *; };\" > /tmp/stub/dl.map
  gcc -shared -fPIC -Wl,-soname,libdl.so.2 -Wl,--version-script=/tmp/stub/dl.map /tmp/stub/dl.c -o /tmp/stub/libdl.so.2
  gcc -O2 -s -shared -fPIC -Wall -Wextra -Werror -ftls-model=initial-exec -fno-stack-protector -U_FORTIFY_SOURCE \
    native/vfspreload.c -L/tmp/stub -Wl,--no-as-needed -l:libdl.so.2 -o $out/vfspreload.so
"
echo "built $out/vfspreload.so"
sh "$root/native/symbols.sh" "$arch"
