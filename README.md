# Rowdy GitHub Action

Deploys a container to AWS Lambda with a Function URL in front of it, and can run the container
on a schedule. This branch is the Action; the runtime, the `Routes` manifest and `spec.crontab`
are documented on [`main`](https://github.com/scaffoldly/rowdy/blob/main/README.md).

## Getting started

The Action needs an AWS role it can assume through OIDC, so the job requires `id-token: write` and
an `AWS_ROLE_ARN` in its environment. Given a Dockerfile, it also builds and pushes the image to
GitHub Packages, which needs `packages: write`:

```yaml
permissions:
  contents: read
  id-token: write
  packages: write

env:
  AWS_ROLE_ARN: ${{ vars.AWS_ROLE_ARN }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Rowdy Deploy
        id: rowdy
        uses: scaffoldly/rowdy@github
        with:
          cloud: aws
          compute: lambda
          name: ${{ github.repository }}
          dockerfile: ./Dockerfile
          routes: |
            default: "http://localhost:3000/"
          volumes: |
            s3://my-bucket:/data

      - run: echo "deployed to ${{ steps.rowdy.outputs.url }}"
```

Change `default` to the port the container listens on. When the job has not checked anything out,
the Action checks out the commit that triggered the workflow, which is where `dockerfile` and a
`routes` path are read from; a job that checked out on its own keeps its checkout. The deployed
URL comes back as `steps.<id>.outputs.url`, which is how a downstream step (a DNS record, a CDN
origin, a smoke test) learns where the function lives.

### Building the image

With `dockerfile`, the Action builds the image for `linux/amd64` from the Dockerfile's directory,
pushes it as `ghcr.io/<owner>/<repo>:rowdy`, and deploys it as `:rowdy@<digest>`. The function runs
exactly what was just built. The Lambda alias, and the Function URL attached to it, are named after
the tag, so the URL stays the same from one build to the next. The `:rowdy` tag belongs to the
Action and leaves the repository's other tags alone. The build cache lives in the GitHub Actions
cache under the `rowdy` scope for the same reason.

Every one of `secrets` is also a [BuildKit secret](https://docs.docker.com/build/building/secrets/)
for that build, by its name, whether the Dockerfile uses it or not. A `RUN` gets one only by asking
for it, and it's never in the image: not in a layer, its config or its history, as a build arg would
be. For a tool that reads one from its environment, like `@sentry/nextjs` reading `SENTRY_AUTH_TOKEN`:

```dockerfile
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN,env=SENTRY_AUTH_TOKEN npm run build
```

A build that needs a different context, build arguments or another registry belongs in its own
steps. Pass the result as `image` instead (`image` is ignored when `dockerfile` is set). Keep a tag
in front of the digest: an image with only a digest gets a new alias, and a new Function URL, on
every build.

```yaml
- uses: docker/build-push-action@v7
  id: build
  with:
    context: .
    file: standalone/Dockerfile
    push: true
    tags: ghcr.io/${{ github.repository }}:main

- uses: scaffoldly/rowdy@github
  with:
    cloud: aws
    compute: lambda
    image: ghcr.io/${{ github.repository }}:main@${{ steps.build.outputs.digest }}
```

Log verbosity comes from `ROWDY_LOG_LEVEL` in the environment (`error`, `warn`, `info`, `debug` or
`trace`; `info` when unset), set on the job or on the step. It applies to the deploy and is carried
into the deployed function:

```yaml
- uses: scaffoldly/rowdy@github
  env:
    ROWDY_LOG_LEVEL: debug
  with: …
```

The Action assumes the role with `aws-actions/configure-aws-credentials`, using `AWS_REGION` from
the environment if set and `us-east-1` otherwise.

## Prebuilding a microVM image

With `compute: microvm` and `ROWDY_BUILD: true` in the step's `env`, the Action prebuilds a microVM
image from a Dockerfile instead of deploying anything. A sandbox created later from exactly what the
image was built from starts from it in seconds, instead of building one for about two minutes. See
[Prebuilt microVM images](https://github.com/scaffoldly/rowdy/blob/main/docs/runtime.md#prebuilt-microvm-images)
on `main`.

```yaml
jobs:
  prebuild:
    strategy:
      matrix:
        runner: [ubuntu-24.04, ubuntu-24.04-arm]
        memory: [512, 1024, 2048]
    runs-on: ${{ matrix.runner }}
    permissions:
      contents: read
      packages: write
      id-token: write
    steps:
      - uses: scaffoldly/rowdy@github
        id: rowdy
        with:
          cloud: aws
          compute: microvm
          dockerfile: prebuild/ubuntu/Dockerfile
          name: ubuntu
          memory: ${{ matrix.memory }}
          layers-from: ghcr.io/tunneld-it/tunneld:latest
        env:
          ROWDY_BUILD: true
          AWS_ROLE_ARN: ${{ vars.AWS_ROLE_ARN }}
```

- **Where it's pushed:** `ghcr.io/<owner>/prebuild/<name>`. `name` must be a valid image name:
  lowercase letters and digits, with `.`, `_` or `-` between them. A new package on ghcr.io is
  private. Make it public once in its settings: a sandbox looking for a prebuilt image reads it
  without credentials.
- **The platform is the runner's:** `linux/amd64` on an X64 runner and `linux/arm64` on an ARM64
  one, each built natively, with no QEMU.
- **Push by digest:** each run pushes only its platform's image, by digest, with no tag, so cells
  for different platforms don't overwrite each other. The build is reproducible (timestamps pinned
  with `SOURCE_DATE_EPOCH=0` and `rewrite-timestamp`, no provenance), so an unchanged Dockerfile
  gives the same digest and pushes nothing new.
- **The base:** rowdy reads the Dockerfile's last stage's `FROM`, and that image's digest for the
  platform, into the prebuilt image's `from` and `from.sha256` tags. A `FROM` of an earlier
  stage, an `ARG` with no default, or `scratch` gets none.
- **Then `--build`:** the Action runs `rowdy create aws microvm --build` on that digest, with
  `memory` and `layers-from`, and sets `arn`, `status` (`built` or `reused`) and `digest`.
- **The tag is yours to make:** a matrix's jobs can't hand their outputs to one job, so the Action
  doesn't combine the platforms. A last job does, from each cell's `digest` (passed on as an
  artifact, for example):

  ```sh
  docker buildx imagetools create -t ghcr.io/<owner>/prebuild/ubuntu:latest \
    ghcr.io/<owner>/prebuild/ubuntu@<amd64 digest> \
    ghcr.io/<owner>/prebuild/ubuntu@<arm64 digest>
  ```

  Callers name that tag, and a sandbox resolves it to its platform's digest.

## Inputs

| Input         | Required | Default                    | Description                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud`       | yes      |                            | Cloud provider. `aws` today.                                                                                                                                                                                                                                                                                                                                 |
| `compute`     | yes      |                            | Compute type. `lambda` today.                                                                                                                                                                                                                                                                                                                                |
| `dockerfile`  | one of   |                            | Dockerfile to build, push to `ghcr.io/<owner>/<repo>:rowdy` and deploy as `:rowdy@<digest>`. The build context is its directory. See [Building the image](#building-the-image).                                                                                                                                                                              |
| `image`       | one of   |                            | Container image to deploy, such as `ghcr.io/owner/repo@sha256:…`. Ignored when `dockerfile` is set.                                                                                                                                                                                                                                                          |
| `name`        | no       | the execution role's id    | Application name. Becomes the function name, sanitized.                                                                                                                                                                                                                                                                                                      |
| `command`     | no       | image `ENTRYPOINT`+`CMD`   | Override the command the container runs.                                                                                                                                                                                                                                                                                                                     |
| `memory`      | no       | `256`, or `512` on microvm | Memory for the container, in megabytes. On `microvm`, one of 512, 1024, 2048, 4096 or 8192.                                                                                                                                                                                                                                                                  |
| `cri`         | no       | `false`                    | Enable the Container Runtime Interface.                                                                                                                                                                                                                                                                                                                      |
| `routes`      | no       |                            | Path to, or inline YAML/JSON of, a Routes manifest. Accepts a path, `file://`, `data:`, or the manifest inline. A bare spec is accepted. See [Routes](https://github.com/scaffoldly/rowdy/blob/main/README.md#routes) on `main`.                                                                                                                             |
| `secrets`     | no       |                            | Environment variables for the function: `NAME=value` lines and JSON objects such as `${{ toJSON(secrets) }}`, in any mix; lines override the JSON. See [Secrets](https://github.com/scaffoldly/rowdy/blob/main/docs/secrets.md) on `main`. Also BuildKit secrets for a `dockerfile` build: see [Building the image](#building-the-image).                    |
| `volumes`     | no       |                            | Volumes to mount, one per line, such as `s3://my-bucket:/data`. Added to any `volumes` in `routes`. See [Volumes](https://github.com/scaffoldly/rowdy/blob/main/docs/volumes.md) on `main`.                                                                                                                                                                  |
| `layers-from` | no       |                            | Images whose one layer is added to the deployed image before rowdy's, one per line, such as `ghcr.io/tunnel-pizza/tunneld:latest`. Each must be public and built like rowdy's final stage (`FROM scratch`, one `COPY`), or the deploy fails. See [Your own layers](https://github.com/scaffoldly/rowdy/blob/main/docs/runtime.md#your-own-layers) on `main`. |

| Output   | Description                                                                                |
| -------- | ------------------------------------------------------------------------------------------ |
| `url`    | The deployed Function URL.                                                                 |
| `image`  | The image reference that was deployed.                                                     |
| `digest` | The digest of the image built from `dockerfile`. With `ROWDY_BUILD`, the platform image's. |
| `arn`    | With `ROWDY_BUILD`, the prebuilt microVM image's ARN.                                      |
| `status` | With `ROWDY_BUILD`, `built` or `reused`.                                                   |

## Scheduled requests

A `crontab` list in `routes` runs the container on a schedule. Each line is a POSIX crontab
schedule, an optional HTTP method, and a URI the request is sent to inside the container. On AWS
each line becomes an EventBridge Scheduler schedule targeting the function. The request arrives
with `X-Rowdy-Cron` set to the line that triggered it. Rowdy strips that header from every
Function URL request, and a raw invocation needs an in-account IAM principal, so an app can treat
its presence as proof the request came from its own schedule. The full grammar, the trust argument, and the deployer permissions are in
[Scheduled requests](https://github.com/scaffoldly/rowdy/blob/main/README.md#scheduled-requests)
on `main`.

### Worked example: tunnel.pizza

[tunnel-pizza/tunnel.pizza](https://github.com/tunnel-pizza/tunnel.pizza) is a Next.js app in a
container with a garbage-collection endpoint that used to run from a GitHub `schedule:` workflow.
It now runs from a crontab line.

The deploy step, from
[`.github/workflows/main.yml`](https://github.com/tunnel-pizza/tunnel.pizza/blob/402e678/.github/workflows/main.yml#L59-L76):

```yaml
- name: Rowdy Deploy
  id: rowdy
  uses: scaffoldly/rowdy@github
  with:
    cloud: aws
    compute: lambda
    name: ${{ github.repository }}
    image: ghcr.io/${{ github.repository }}:latest
    memory: 512
    routes: |
      default: "http://localhost:3000/"
      crontab:
        - "*/15 * * * * POST http://localhost:3000/tunnel/gc"
    secrets: ${{ toJSON(secrets) }}
```

A later step hands `steps.rowdy.outputs.url` to a Cloudflare Worker as its origin.

How the app trusts the scheduled request, from
[`src/lib/auth.ts`](https://github.com/tunnel-pizza/tunnel.pizza/blob/402e678/src/lib/auth.ts#L65-L75):

```ts
export function fromRowdyCron(headers: Headers): boolean {
  return headers.has("x-rowdy-cron");
}
```

And the route that consumes it, from
[`src/app/tunnel/gc/route.ts`](https://github.com/tunnel-pizza/tunnel.pizza/blob/402e678/src/app/tunnel/gc/route.ts#L29-L33):

```ts
export async function POST(req: NextRequest) {
  if (!fromRowdyCron(req.headers)) {
    const auth = await authorizeAdmin(req.headers.get("authorization"));
    if (!auth.ok) return unauthorized(auth.reason);
  }
  // ... sweep
}
```

To check a deploy of your own:

```sh
aws scheduler list-schedules --group-name <function-name>

curl -si -X POST -H 'x-rowdy-cron: forged' https://<your-app>/<your-cron-path>
```

The expected answer is whatever the endpoint returns to an unauthenticated caller. If it answers
the same with the header as without, the header never reached the app.
