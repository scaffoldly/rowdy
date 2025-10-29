FROM node:22-alpine AS full
ARG CACHE_ID=default

RUN apk add --no-cache git

WORKDIR /work
COPY . .

RUN --mount=type=cache,id=${CACHE_ID}-yarn,target=/usr/local/share/.cache/yarn \
    yarn install --frozen-lockfile

ENTRYPOINT [ "yarn" ]
CMD [ "dev" ]

FROM node:22-alpine AS exe
ARG CACHE_ID=default

WORKDIR /work
COPY --from=full /work /work
ENV PKG_CACHE_PATH=/usr/local/share/.cache/pkg
RUN --mount=type=cache,id=${CACHE_ID}-yarn,target=/usr/local/share/.cache/yarn \
    --mount=type=cache,id=${CACHE_ID}-pkg,target=/usr/local/share/.cache/pkg \
    yarn build:exe --debug && \
    /work/bin/rowdy --version

FROM alpine:latest
COPY --from=exe /work/bin/rowdy /usr/local/bin/rowdy
ENTRYPOINT [ "/usr/local/bin/rowdy" ]
