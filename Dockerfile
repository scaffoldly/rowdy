FROM node:22-alpine AS install

RUN apk add --no-cache git

WORKDIR /work
COPY package.json /work/package.json
COPY yarn.lock /work/yarn.lock

RUN --mount=type=cache,id=yarn,target=/usr/local/share/.cache/yarn \
    yarn install --frozen-lockfile

FROM node:22-alpine AS build
ENV PKG_CACHE_PATH=/usr/local/share/.cache/pkg

WORKDIR /work
COPY . .
COPY --from=install /work/node_modules /work/node_modules
RUN --mount=type=cache,id=pkg,target=/usr/local/share/.cache/pkg \
    yarn build:exe --debug

# DEVNOTE: A rowdy that never reached main() still exits 0, so these check what it printed. The second
# proves a chunk loads from inside the binary, which --version doesn't touch.
RUN test -n "$(/work/bin/rowdy --version)" && \
    echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | \
      /work/bin/rowdy mcp | grep -q serverInfo

# DEVNOTE: Commands rowdy spawns must reach the image's own node, which pkg's child_process patch swaps for rowdy
# unless patches/ undoes it. PKG_EXECPATH set to its own path runs a script on rowdy's embedded Node.
RUN printf '%s' "const r = require('child_process').spawnSync('sh', ['-c', 'node -e \"process.stdout.write(process.execPath)\"'], { encoding: 'utf8' }); process.exit(r.stdout === '/usr/local/bin/node' && !process.env.PKG_EXECPATH ? 0 : 1);" > /tmp/spawn.js && \
    PKG_EXECPATH=/work/bin/rowdy /work/bin/rowdy /tmp/spawn.js

# DEVNOTE: The final stage is scratch because its layers are appended to every deployed image. The
# binary must therefore be static: an interpreter would have to come from the user's image.
RUN apk add --no-cache binutils && \
    if readelf -lW /work/bin/rowdy | grep -q 'program interpreter'; then \
      echo 'bin/rowdy is dynamically linked; it must be static to run from scratch' >&2; exit 1; \
    fi

FROM scratch
COPY --from=build /work/bin/rowdy /usr/local/bin/rowdy
ENTRYPOINT [ "/usr/local/bin/rowdy" ]
