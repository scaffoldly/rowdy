# Sandbox Image

The base image for [`@scaffoldly/rowdy/sandbox`](https://github.com/scaffoldly/rowdy): Python, Node, npm, pip, git, curl and jq on Debian trixie, with procps (`ps`, `pkill`, `pgrep`, `top`), iproute2 (`ss`, `ip`), `lsof`, `file`, and busybox for other everyday tools (`killall`, `wget`, `unzip`, `xz`, `less`, `vi`, `nc` and more), in one layer, for `linux/amd64` and `linux/arm64`.

```
ghcr.io/scaffoldly/sandbox
docker.io/scaffoldly/sandbox
```

There are no compilers, so packages that build native code on install will fail. Files are copied in rather than installed, so `apt-get` doesn't know about them.

## Verifying an image

Every published image carries signed build provenance and SBOM attestations, plus BuildKit's own:

```
gh attestation verify \
  oci://ghcr.io/scaffoldly/sandbox:latest \
  --repo scaffoldly/rowdy
```

## License

The image is licensed by its contents, listed in the `org.opencontainers.image.licenses` label, with full texts inside it. The `Dockerfile` derives from work under [`LICENSE.e2b`](LICENSE.e2b) and [`LICENSE.docker-node`](LICENSE.docker-node). Everything else here is under [`LICENSE.md`](LICENSE.md).
