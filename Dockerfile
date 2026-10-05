FROM node:22-alpine AS install

RUN apk add --no-cache git

WORKDIR /work
COPY package.json /work/package.json
COPY yarn.lock /work/yarn.lock

RUN --mount=type=cache,id=yarn,target=/usr/local/share/.cache/yarn \
    yarn install --frozen-lockfile

FROM node:22-alpine AS build
ENV PKG_CACHE_PATH=/usr/local/share/.cache/pkg

# Toolchain for the userspace-VFS preload shim (musl target).
RUN apk add --no-cache gcc musl-dev linux-headers

WORKDIR /work
COPY . .
COPY --from=install /work/node_modules /work/node_modules
RUN --mount=type=cache,id=pkg,target=/usr/local/share/.cache/pkg \
    yarn build:exe --debug && \
    /work/bin/rowdy --version
# Compile the opt-in VFS preload (LD_PRELOAD libc interposer). Shipped in the
# rowdy layer; activated per-deploy via ROWDY_VFS. musl-linked -> only loads
# into musl/alpine child images.
RUN gcc -O2 -shared -fPIC -Wall -Wextra -Werror native/vfspreload.c -o /work/bin/vfspreload.so

FROM alpine:latest
COPY --from=build /work/bin/rowdy /usr/local/bin/rowdy
COPY --from=build /work/bin/vfspreload.so /usr/local/lib/rowdy/vfspreload.so
ENTRYPOINT [ "/usr/local/bin/rowdy" ]
