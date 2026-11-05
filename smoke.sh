#!/bin/sh
# Files are copied into the image, so a missing one only shows up at runtime, as the failure of one tool.
set -eu

cd "$(mktemp -d)"

python3 --version
pip --version
node --version
npm --version
git --version
curl --version

python3 -c "import asyncio, bz2, ctypes, hashlib, lzma, readline, sqlite3, ssl, uuid, zlib"

python3 -c "import urllib.request as u; assert u.urlopen('https://pypi.org/simple/', timeout=30).status == 200"
node -e "fetch('https://registry.npmjs.org/is-odd').then((r) => process.exit(r.ok ? 0 : 1))"
curl -fsS -o /dev/null https://github.com

git clone -q --depth 1 https://github.com/octocat/Hello-World hello
pip install -q --root-user-action=ignore --no-cache-dir --target pip requests
npm install --silent --prefix npm is-odd

for absent in gcc gh gpg xz yarn; do
  if command -v "$absent" >/dev/null; then
    echo "$absent should not be in the image" >&2
    exit 1
  fi
done
