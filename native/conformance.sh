#!/bin/sh
# Mounts the package's 9P server with the Linux kernel's own client (v9fs over a unix socket) and
# drives it through ordinary tools: the server is a correct 9P2000.L file server, not only the shim's
# counterpart. Linux only, needs root for mount(2) and the 9p modules. Needs dist/ built.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*"; exit 1; }

sudo modprobe 9pnet_fd 2>/dev/null || sudo modprobe 9pnet || true
sudo modprobe 9p || fail "no 9p module on this kernel"

rm -f /tmp/ops.log /tmp/vfs.ready
node "$root/native/test-server.js" > /tmp/server.out 2>&1 &
SRVPID=$!
for i in $(seq 1 20); do [ -f /tmp/vfs.ready ] && break; sleep 0.25; done
[ -f /tmp/vfs.ready ] || { cat /tmp/server.out; fail "server did not start"; }

sudo mkdir -p /mnt/vfs
sudo mount -t 9p -o trans=unix,version=9p2000.L,aname=/vfs,uname=rowdy,access=any,cache=none,msize=65536 /tmp/vfs.sock /mnt/vfs \
  || { dmesg 2>/dev/null | tail -5; cat /tmp/server.out; fail "mount"; }
trap 'sudo umount /mnt/vfs 2>/dev/null || true; kill $SRVPID 2>/dev/null || true' EXIT
echo "mounted: $(mount | grep /mnt/vfs)"

cd /mnt/vfs
sudo sh -c 'echo hello > /mnt/vfs/a.txt'
[ "$(cat a.txt)" = "hello" ] || fail "write then read"
[ "$(cat /tmp/vfsstore/a.txt)" = "hello" ] || fail "bytes landed in the backing directory"
sudo mkdir /mnt/vfs/d
sudo mv /mnt/vfs/a.txt /mnt/vfs/d/b.txt
[ "$(cat d/b.txt)" = "hello" ] && [ ! -e a.txt ] || fail "rename"
[ "$(ls | tr '\n' ' ')" = "d " ] || fail "readdir: $(ls)"
sudo sh -c 'dd if=/dev/urandom of=/tmp/big.bin bs=1k count=1024 2>/dev/null; cp /tmp/big.bin /mnt/vfs/d/big.bin'
cmp -s /tmp/big.bin /tmp/vfsstore/d/big.bin || fail "1 MiB copy through Tread/Twrite"
sudo ln -s /mnt/vfs/d/b.txt /mnt/vfs/lnk
[ "$(readlink lnk)" = "/mnt/vfs/d/b.txt" ] || fail "symlink/readlink: $(readlink lnk)"
sudo truncate -s 2 /mnt/vfs/d/b.txt
[ "$(cat d/b.txt)" = "he" ] || fail "truncate via setattr"
sudo chmod 600 /mnt/vfs/d/b.txt
[ "$(stat -c %a d/b.txt)" = "600" ] || fail "chmod via setattr"
cd /
sudo rm /mnt/vfs/d/big.bin /mnt/vfs/d/b.txt /mnt/vfs/lnk
sudo rmdir /mnt/vfs/d
[ -z "$(ls /mnt/vfs)" ] || fail "cleanup: $(ls /mnt/vfs)"

for hook in "stat /vfs" "open /vfs/a.txt" "flush /vfs/a.txt" "list /vfs" "mkdir /vfs/d" "rename /vfs/a.txt /vfs/d/b.txt" "unlink /vfs/d"; do
  grep -q "^$hook" /tmp/ops.log || fail "adapter hook missing: $hook (log: $(tr '\n' ' ' < /tmp/ops.log))"
done
echo "v9fs conformance: ok"
