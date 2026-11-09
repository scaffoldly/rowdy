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
ps --version
pkill --version
pgrep --version
jq --version
ss --version
ip -V
file --version

# The tools to find, stop and see what a sandbox started.
sleep 300 &
pgrep -x sleep >/dev/null
pkill -x sleep
echo '{"a":1}' | jq -e '.a == 1' >/dev/null
for tool in top killall netstat wget unzip xz less; do
  command -v "$tool" >/dev/null
done

# Which process has a port.
python3 -m http.server 8765 >/dev/null 2>&1 &
server=$!
for _ in $(seq 50); do ss -tln | grep -q ':8765 ' && break; sleep 0.1; done
ss -tlnp | grep ':8765 ' | grep -q "pid=$server"
lsof -t -i :8765 | grep -qx "$server"
kill "$server"
ip addr show lo >/dev/null
file /usr/bin/git | grep -q ELF

python3 -c "import asyncio, bz2, ctypes, hashlib, lzma, readline, sqlite3, ssl, uuid, zlib"

python3 -c "import urllib.request as u; assert u.urlopen('https://pypi.org/simple/', timeout=30).status == 200"
node -e "fetch('https://registry.npmjs.org/is-odd').then((r) => process.exit(r.ok ? 0 : 1))"
curl -fsS -o /dev/null https://github.com

git clone -q --depth 1 https://github.com/octocat/Hello-World hello
pip install -q --root-user-action=ignore --no-cache-dir --target pip requests
npm install --silent --prefix npm is-odd

for absent in gcc gh gpg yarn; do
  if command -v "$absent" >/dev/null; then
    echo "$absent should not be in the image" >&2
    exit 1
  fi
done
