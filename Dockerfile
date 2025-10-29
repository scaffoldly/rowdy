FROM node:22-alpine AS install
ARG CACHE_ID=default

RUN apk add --no-cache git

WORKDIR /work
COPY package.json /work/package.json
COPY yarn.lock /work/yarn.lock

RUN yarn install --frozen-lockfile

FROM node:22-alpine AS build
ARG CACHE_ID=default
ENV PKG_CACHE_PATH=/usr/local/share/.cache/pkg

WORKDIR /work
COPY . .
COPY --from=install /work/node_modules /work/node_modules
RUN --mount=type=cache,id=pkg,target=/usr/local/share/.cache/pkg \
    yarn build:exe --debug && \
    /work/bin/rowdy --version

FROM alpine:latest
COPY --from=build /work/bin/rowdy /usr/local/bin/rowdy
ENTRYPOINT [ "/usr/local/bin/rowdy" ]
