#!/bin/sh
# Unit tests for the shim's headers. Each tests/native/unit/test_*.c includes the header it tests, so its
# static functions are in reach, and runs under cmocka, built with AddressSanitizer and
# UndefinedBehaviorSanitizer (any finding fails the run) in the pinned Debian 12 image that
# native/build.sh compiles the shim in. tests/native/test.sh covers what only a preloaded process shows.
#
#   sh tests/native/unit.sh x64|arm64
set -eu

arch="${1:-}"
case "$arch" in
  x64)   platform=linux/amd64 ;;
  arm64) platform=linux/arm64 ;;
  *) echo "usage: $0 x64|arm64" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/../.." && pwd)"

docker run --rm --platform "$platform" -v "$root:/w:ro" -w /w \
  debian:12@sha256:2c037a04925515fdd6ea85ea14a682d0e79931f5e9f5d07b6dbfc6ba12f9e858 sh -euc '
  sh /w/native/apt-snapshot.sh
  apt-get -qq update >/dev/null
  apt-get -qq install -y --no-install-recommends gcc libc6-dev libcmocka-dev >/dev/null
  # Locals stay on the real stack, which the fault report tests look for in /proc/self/maps.
  export ASAN_OPTIONS=detect_stack_use_after_return=0:detect_leaks=1 UBSAN_OPTIONS=print_stacktrace=1
  export CMOCKA_MESSAGE_OUTPUT=TAP
  for test in tests/native/unit/test_*.c; do
    name=$(basename "$test" .c)
    gcc -std=gnu11 -g -O1 -Wall -Wextra -Werror -Wno-unused-function -fno-omit-frame-pointer \
      -fsanitize=address,undefined -fno-sanitize-recover=all -Inative "$test" -o "/tmp/$name" \
      -lcmocka -ldl -lpthread
    "/tmp/$name"
  done
'
