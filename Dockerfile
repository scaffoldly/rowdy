FROM node:22-alpine AS full
RUN apk add --no-cache git

WORKDIR /work
COPY . .

# The Server
RUN yarn install --frozen-lockfile

ENTRYPOINT [ "yarn" ]
CMD [ "start:dev" ]

FROM node:22-alpine AS exe
WORKDIR /work
COPY --from=full /work /work
ENV PKG_CACHE_PATH=/usr/local/share/.cache/pkg
RUN --mount=type=cache,target=/usr/local/share/.cache/pkg \
    yarn build:exe --debug && \
    ls -alR /work/bin && \
    /work/bin/rowdy --version

FROM alpine:latest
COPY --from=exe /work/bin/rowdy /usr/local/bin/rowdy
ENTRYPOINT [ "/usr/local/bin/rowdy" ]
