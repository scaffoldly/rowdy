#!/bin/sh
# node's own fs/promises tests (native/nodefs/node, vendored verbatim from nodejs/node v22.23.3) run in
# the image as the unprivileged `node` user, with their tmpdir on the store the dimension names:
#
#   volume   a docker named volume mounted at /data, created for the run and removed after it
#
#   sh native/nodefs.sh x64|arm64 alpine|debian volume [--filter <regex>]
set -eu

if [ ! -f /.dockerenv ]; then
  arch="${1:-}"; flavour="${2:-}"; store="${3:-}"
  usage="usage: $0 x64|arm64 alpine|debian volume [--filter <regex>]"
  case "$arch" in
    x64)   platform=linux/amd64 ;;
    arm64) platform=linux/arm64 ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
  case "$flavour" in
    alpine) image=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 ;;
    debian) image=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
  case "$store" in
    volume) ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
  shift 3
  root="$(cd "$(dirname "$0")/.." && pwd)"
  volume="rowdy-nodefs-$$"
  docker volume create "$volume" >/dev/null
  trap 'docker volume rm -f "$volume" >/dev/null' EXIT
  # A fresh named volume is root's; the tests run as `node`, as an app does.
  docker run --rm --platform "$platform" -v "$volume:/data" "$image" chown node:node /data
  status=0
  docker run --rm --platform "$platform" --user node -e NODEFS_STORE="$store" \
    -v "$root:/w:ro" -v "$volume:/data" "$image" sh /w/native/nodefs.sh "$@" || status=$?
  exit "$status"
fi

echo "store: $NODEFS_STORE, node $(node -v), $(id -un)"
node /w/native/nodefs/run.js --dir /data/nodefs "$@"
