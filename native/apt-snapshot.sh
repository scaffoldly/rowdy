#!/bin/sh
# Point a Debian 12 container's apt at one snapshot.debian.org timestamp, so the compiler that
# builds the shim is the same on every run and survives bookworm moving to the archive. Run inside
# the container before apt-get; the image itself is pinned by digest where it is used.
#
#   sh /w/native/apt-snapshot.sh && apt-get -qq update
set -eu

SNAPSHOT=20261008T000000Z

rm -f /etc/apt/sources.list
cat > /etc/apt/sources.list.d/debian.sources <<EOF
Types: deb
URIs: http://snapshot.debian.org/archive/debian/$SNAPSHOT
Suites: bookworm bookworm-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: http://snapshot.debian.org/archive/debian-security/$SNAPSHOT
Suites: bookworm-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
# A snapshot's Release files carry their original Valid-Until, long past.
echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99snapshot
