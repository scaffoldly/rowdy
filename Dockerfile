# Copyright 2023 FoundryLabs, Inc. Apache-2.0: see LICENSE.e2b. Started from templates/base/e2b.Dockerfile of e2b-dev/E2B
# at 73a784dcb5159a7a3e5449e50c45b5a05dda5c9e.
# Copyright (c) 2015 Joyent, Inc. MIT: see LICENSE.docker-node. The node stage comes from nodejs/docker-node at
# 4730c96eda1aefbf7b952fd725d6b37e9e531a8c.
# Modifications copyright 2026 Scaffoldly.
# Modified: rebuilt on debian-slim from only the files Python, Node, git and curl need, so without compilers, -dev
# libraries, gh, Yarn or Node's headers; Python, Node and the Node release keys are bumped; ca-certificates, the pip and certifi upgrade,
# and NODE_OPTIONS come from e2bdev/base's image history. Its removal of the emSign ECC G3 and Comodo AAA roots is
# left out, as trixie's ca-certificates no longer ships them.

# From https://github.com/nodejs/docker-node/blob/4730c96eda1aefbf7b952fd725d6b37e9e531a8c/26/trixie/Dockerfile
FROM debian:trixie-slim AS node

ENV NODE_VERSION=26.13.0

RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl dirmngr gnupg xz-utils

RUN ARCH= && dpkgArch="$(dpkg --print-architecture)" \
  && case "${dpkgArch##*-}" in \
    amd64) ARCH='x64';; \
    arm64) ARCH='arm64';; \
    *) echo "unsupported architecture"; exit 1 ;; \
  esac \
  # use pre-existing gpg directory, see https://github.com/nodejs/docker-node/pull/1895#issuecomment-1550389150
  && export GNUPGHOME="$(mktemp -d)" \
  # gpg keys listed at https://github.com/nodejs/node#release-keys
  && set -ex \
  && for key in \
    5BE8A3F6C8A5C01D106C0AD820B1A390B168D356 \
    DD792F5973C6DE52C432CBDAC77ABFA00DDBF2B7 \
    CC68F5A3106FF448322E48ED27F5E38D5B0A215F \
    890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4 \
    C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C \
    108F52B48DB57BB0CC439B2997B01419BD92F80A \
    655F3B5C1FB3FA8D1A0CA6BDE4A7D232B936D2FD \
    A363A499291CBBC940DD62E41F10027AF002F8B0 \
  ; do \
      gpg --batch --keyserver hkps://keys.openpgp.org --recv-keys "$key" || \
      gpg --batch --keyserver keyserver.ubuntu.com --recv-keys "$key" ; \
  done \
  && curl -fsSLO --compressed "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.xz" \
  && curl -fsSLO --compressed "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt.asc" \
  && gpg --batch --decrypt --output SHASUMS256.txt SHASUMS256.txt.asc \
  && gpgconf --kill all \
  && rm -rf "$GNUPGHOME" \
  && grep " node-v$NODE_VERSION-linux-$ARCH.tar.xz\$" SHASUMS256.txt | sha256sum -c - \
  && mkdir /opt/node \
  && tar -xJf "node-v$NODE_VERSION-linux-$ARCH.tar.xz" -C /opt/node --strip-components=1 --no-same-owner \
  && rm -rf /opt/node/CHANGELOG.md /opt/node/README.md /opt/node/include /opt/node/share \
  && mkdir -p /opt/node/share/doc/node \
  && mv /opt/node/LICENSE /opt/node/share/doc/node/LICENSE \
  && ln -s node /opt/node/bin/nodejs

# Python, Node, git and curl, each with only the shared libraries it links, in a tree for the final image.
FROM python:3.15.2-slim AS rootfs

# The final image is assembled by COPY, so its SBOM needs this stage scanned too.
ARG BUILDKIT_SBOM_SCAN_STAGE=true

RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl git libatomic1 libstdc++6

RUN pip install --no-cache-dir --upgrade "pip>=26.2.2" "certifi>=2026.10.19"

COPY --from=node /opt/node/ /usr/local/

# /lib is a symlink on Debian, so each library lands under its resolved directory. libc comes from the final base.
RUN set -eu \
  && mkdir /rootfs \
  && cp -a --parents \
    /etc/ca-certificates.conf /etc/ssl \
    /usr/bin/curl /usr/bin/git /usr/lib/git-core /usr/lib/ssl /usr/share/ca-certificates /usr/share/git-core \
    /usr/local/bin/node /usr/local/bin/nodejs /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/python /usr/local/bin/python3 /usr/local/bin/python3.15 \
    /usr/local/lib/libpython3.15.so.1.0 /usr/local/lib/libpython3.so \
    /usr/local/lib/node_modules/npm /usr/local/lib/python3.15 /usr/local/share/doc/node \
    /rootfs \
  && find /usr/share/doc -name copyright -exec cp -a --parents {} /rootfs \; \
  && find /rootfs -type f -perm /111 -o -type f -name '*.so*' \
    | xargs ldd 2>/dev/null \
    | awk '$2 == "=>" && $3 ~ /^\// { print $3 }' \
    | sort -u \
    | grep -vE '/lib(c|m|dl|pthread|rt|util|resolv|nsl|nss_[a-z]+)\.so' \
    | while read -r lib; do \
        dir="$(readlink -f "$(dirname "$lib")")"; \
        mkdir -p "/rootfs$dir"; \
        cp -L "$lib" "/rootfs$dir/"; \
      done

FROM debian:trixie-slim AS assembled

ENV LANG=C.UTF-8

ENV NODE_OPTIONS=--use-openssl-ca

COPY --from=rootfs /rootfs/ /

RUN ldconfig \
  && echo 'export NODE_OPTIONS="--use-openssl-ca${NODE_OPTIONS:+ $NODE_OPTIONS}"' > /etc/profile.d/node-ca.sh \
  && groupadd -r node && useradd -r -g node -s /bin/bash -m node

# smoke tests
RUN python3 --version \
  && pip --version \
  && node --version \
  && npm --version \
  && git --version \
  && curl --version

# A single layer. Environment and labels don't carry over from a COPY.
FROM scratch

# revision, version and created are the build's to set. Full license texts: /usr/share/doc/*/copyright,
# /usr/local/share/doc/node/LICENSE, /usr/local/lib/python3.15/LICENSE.txt, and each package under node_modules
# and site-packages.
LABEL org.opencontainers.image.title="scaffoldly/sandbox" \
  org.opencontainers.image.description="Python, Node, git and curl for a rowdy sandbox" \
  org.opencontainers.image.url="https://rowdy.run" \
  org.opencontainers.image.source="https://github.com/scaffoldly/rowdy" \
  org.opencontainers.image.vendor="Scaffoldly" \
  org.opencontainers.image.licenses="PSF-2.0 AND MIT AND Artistic-2.0 AND MPL-2.0 AND GPL-2.0-only AND curl"

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ENV LANG=C.UTF-8

ENV NODE_OPTIONS=--use-openssl-ca

COPY --from=assembled / /

CMD ["python3"]
