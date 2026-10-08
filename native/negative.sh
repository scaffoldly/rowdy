#!/bin/sh
# Negative cases for native/symbols.sh: each object below breaks one rule of ADR 0003, and the gate
# must reject it for that rule (exit 1, with its reason). A gate that passes any of them is broken.
#
#   sh native/negative.sh x64|arm64
set -eu

arch="${1:-}"
case "$arch" in
  x64)   platform=linux/amd64 ;;
  arm64) platform=linux/arm64 ;;
  *) echo "usage: $0 x64|arm64" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
out=".negative/linux-$arch"
rm -rf "${root:?}/$out"
mkdir -p "$root/$out"

# Built against musl: DT_NEEDED is libc.musl-*.so.1.
docker run --rm --platform "$platform" -v "$root:/w" -w /w \
  alpine:3@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 sh -euc "
  apk add --no-cache gcc musl-dev >/dev/null
  echo '#include <stdio.h>
int vfs_musl(void) { return puts(\"musl\"); }' > /tmp/musl.c
  gcc -O2 -s -shared -fPIC /tmp/musl.c -o $out/musl.so
"

# The release flags of native/build.sh, each with one rule broken.
docker run --rm --platform "$platform" -v "$root:/w" -w /w \
  debian:12@sha256:2c037a04925515fdd6ea85ea14a682d0e79931f5e9f5d07b6dbfc6ba12f9e858 sh -euc "
  apt-get -qq update >/dev/null
  apt-get -qq install -y --no-install-recommends gcc libc6-dev >/dev/null
  case \$(uname -m) in x86_64) dlver=GLIBC_2.2.5 ;; *) dlver=GLIBC_2.17 ;; esac
  mkdir -p /tmp/stub
  echo 'void *dlsym(void *h, const char *s) { (void)h; (void)s; return 0; }' > /tmp/stub/dl.c
  echo \"\$dlver { global: dlsym; local: *; };\" > /tmp/stub/dl.map
  gcc -shared -fPIC -Wl,-soname,libdl.so.2 -Wl,--version-script=/tmp/stub/dl.map /tmp/stub/dl.c -o /tmp/stub/libdl.so.2
  link='-L/tmp/stub -Wl,--no-as-needed -l:libdl.so.2'

  # Global-dynamic TLS: __tls_get_addr puts ld-linux in DT_NEEDED.
  gcc -O2 -s -shared -fPIC -fno-stack-protector -U_FORTIFY_SOURCE \
    native/vfspreload.c \$link -o $out/tls.so

  # Fortified: glibc-only __*_chk calls that musl does not export.
  gcc -O2 -s -shared -fPIC -ftls-model=initial-exec -fno-stack-protector -D_FORTIFY_SOURCE=2 \
    native/vfspreload.c \$link -o $out/fortify.so

  # Nothing undefined: the gate must not pass vacuously.
  echo 'int vfs_empty(void) { return 0; }' > /tmp/empty.c
  gcc -O2 -s -shared -fPIC /tmp/empty.c -Wl,--no-as-needed -lc \$link -o $out/empty.so
"

failed=0
expect() {
  name="$1" reason="$2"
  if err=$(sh "$root/native/symbols.sh" "$arch" "$out/$name.so" 2>&1 >/dev/null); then
    echo "negative: $name.so passed the gate" >&2
    failed=1
  elif ! printf '%s\n' "$err" | grep -q "$reason"; then
    printf 'negative: %s.so was rejected for the wrong reason (wanted "%s"):\n%s\n' "$name" "$reason" "$err" >&2
    failed=1
  else
    echo "negative: $name.so rejected ($(printf '%s\n' "$err" | tail -1))"
  fi
}

expect musl 'DT_NEEDED must be exactly'
expect tls 'DT_NEEDED must be exactly'
expect fortify 'not exported by musl: .*_chk'
expect empty 'no undefined symbols'

exit "$failed"
