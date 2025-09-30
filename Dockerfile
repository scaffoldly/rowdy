FROM node:22-alpine AS full
RUN apk add --no-cache git

WORKDIR /work
COPY . .

# The Server
RUN --mount=type=cache,target=/usr/local/share/.cache \
    yarn

ENTRYPOINT [ "yarn" ]
CMD [ "start:dev" ]

FROM node:22-alpine AS exe
WORKDIR /work
COPY --from=full /work /work
ENV PKG_CACHE_PATH=/usr/local/share/.cache/pkg
RUN --mount=type=cache,target=/usr/local/share/.cache \
    yarn build:exe --target node22-linuxstatic-x64,node22-linuxstatic-arm64

FROM node:22-alpine AS arch
WORKDIR /work
COPY --from=exe /work/dist/* /work/
RUN ARCH=$(node -e "console.log(process.arch)") && \
    cp app-${ARCH} app && \
    chmod +x app && \
    ./app --version

FROM alpine:latest
COPY --from=arch /work/app /usr/local/bin/router
ENTRYPOINT [ "/usr/local/bin/router" ]
CMD [ "--help" ]
