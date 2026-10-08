# Rowdy

Scaffoldly Serverless Router

Rowdy deploys a container to AWS Lambda, puts a Function URL in front of it, and routes requests
to whatever is listening inside. It can also run the container on a schedule.

## Getting started

The GitHub Action is the shortest path. It needs an AWS role it can assume through OIDC, so the
job requires `id-token: write` and an `AWS_ROLE_ARN` in its environment:

```yaml
permissions:
  id-token: write
  packages: write # for the docker/build-push-action step that usually precedes the deploy

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
          image: ghcr.io/${{ github.repository }}:latest
          routes: |
            default: "http://localhost:3000/"

      - run: echo "deployed to ${{ steps.rowdy.outputs.url }}"
```

Change `image` to a container the runner can pull, and `default` to the port the container listens
on. The deployed URL comes back as `steps.<id>.outputs.url`, which is how a downstream step (a DNS
record, a CDN origin, a smoke test) learns where the function lives. The run's summary page shows
the URL, image, region, alias, memory and volumes; a failed deploy shows the image and the error.
Secrets never appear there.

The Action assumes the role with `aws-actions/configure-aws-credentials`, using `AWS_REGION` from
the environment if set and `us-east-1` otherwise.

### Inputs

| Input     | Required | Default                  | Description                                                                                                                                                     |
| --------- | -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud`   | yes      |                          | Cloud provider. `aws` today.                                                                                                                                    |
| `compute` | yes      |                          | Compute type. `lambda` today.                                                                                                                                   |
| `image`   | yes      |                          | Container image to deploy, such as `ghcr.io/owner/repo@sha256:…`.                                                                                               |
| `name`    | no       | the execution role's id  | Application name. Becomes the function name, sanitized.                                                                                                         |
| `command` | no       | image `ENTRYPOINT`+`CMD` | Override the command the container runs.                                                                                                                        |
| `memory`  | no       | `256`                    | Memory for the container, in megabytes.                                                                                                                         |
| `cri`     | no       | `false`                  | Enable the Container Runtime Interface.                                                                                                                         |
| `routes`  | no       |                          | Path to, or inline YAML/JSON of, a Routes manifest. Accepts a path, `file://`, `data:`, or the manifest inline. A bare spec is accepted. See [Routes](#routes). |
| `secrets` | no       |                          | Environment variables for the function: `NAME=value` lines and JSON objects such as `${{ toJSON(secrets) }}`. See [Secrets](#secrets).                          |

| Output | Description                |
| ------ | -------------------------- |
| `url`  | The deployed Function URL. |

## Routes

`--routes` (or the `ROWDY_ROUTES` environment variable, or `with.routes` in the GitHub Action)
takes a path to a `Routes` manifest, a `file://` or `data:` URL, or the manifest itself inline as
YAML or JSON:

```yaml
apiVersion: rowdy.run/v1alpha1
kind: Routes
spec:
  default: 'http://localhost:3000/'
  paths:
    '/api{/*path}': 'http://localhost:8080/api/*path'
```

The `apiVersion` / `kind` / `spec` wrapper is optional. A bare spec is accepted as shorthand for
the full manifest, which keeps an inline `with.routes` short:

```yaml
default: 'http://localhost:3000/'
crontab:
  - '*/15 * * * * POST http://localhost:3000/tunnel/gc'
```

A path that turns out not to exist falls back to the default routes. An inline manifest that fails
to parse or validate throws, since it cannot be a missing file.

## Scheduled requests

`spec.crontab` lets a deployment run itself on a schedule. Each line is a POSIX crontab schedule,
an optional HTTP method, and a backend URI:

```yaml
spec:
  default: 'http://localhost:3000/'
  crontab:
    - '*/15 * * * * POST http://localhost:3000/tunnel/gc'
```

On AWS each line becomes an EventBridge Scheduler schedule targeting the function's alias, in UTC,
without retries (the next tick is the retry). The request reaches the app with `X-Rowdy-Cron` set
to the line; rowdy strips that header from every public request, so its presence proves the request
came from one of the deployment's own schedules. A response `>= 400` fails the invocation.

Syntax, EventBridge mapping, deployer permissions, trusting the header, and a worked example:
[docs/crontab.md](docs/crontab.md).

## CORS

`spec.cors` maps path patterns to `none` or a CORS policy. The first pattern that matches wins,
and a path no pattern matches is treated as `none`:

```yaml
spec:
  default: 'http://localhost:3000/'
  cors:
    '/oauth{/*path}': none
    '/api{/*path}':
      origins: ['https://app.example']
      credentials: true
```

With `none`, rowdy leaves the app's own CORS headers alone. With a policy, rowdy answers
preflights itself and replaces the app's `Access-Control-*` headers. The Function URL is deployed
with no CORS configuration.

Policy keys, `*` with credentials, and migrating from the old any-origin default:
[docs/cors.md](docs/cors.md).

## Volumes (experimental)

`spec.volumes` gives the app a writable, persistent directory that is not part of the image. Each
entry is `<scheme>://<locator>:<mountpoint>[:<flags>]`:

```yaml
spec:
  default: 'http://localhost:3000/'
  volumes:
    - 's3://my-bucket:/s3:local=*-{journal,wal,shm}'
    - 'file:///tmp/scratch:/scratch'
```

`file://<dir>` backs the mountpoint with a directory on the function's `/tmp`; `s3://<bucket>[/<prefix>]`
backs it with a bucket, fetching objects on first open and uploading them on close or fsync. Several
instances can share an `s3://` volume: uploads are conditional (`ESTALE` on a lost race), and
programs that take advisory locks (SQLite) get a lease in the bucket so their transactions serialize
across instances. The deploy grants the execution role access to the bucket and prefix.

Nothing is mounted in the kernel sense: rowdy preloads the
[`@scaffoldly/rowdy-vfs`](https://github.com/scaffoldly/rowdy/tree/vfs) shim into the app, which
rewrites libc path calls to a backing directory and speaks 9P2000.L to rowdy for the control plane.
Dynamically linked musl and glibc (2.34+) programs see the mountpoint; static binaries do not.

Syntax, flags, sharing semantics, caching, limits and errors: [docs/volumes.md](docs/volumes.md).

## Secrets

`--secrets` (or `ROWDY_SECRETS`, or `with.secrets` in the GitHub Action) sets environment variables on
the function. It takes `NAME=value` lines and JSON objects, in any mix, and a line always overrides
the JSON:

```yaml
secrets: |
  SENTRY_DSN=${{ vars.SENTRY_DSN }}
  ${{ toJSON(secrets) }}
  BUILD_ID=${{ github.run_id }}
```

Syntax, precedence, comments and quoting, multi-line secrets and errors:
[docs/secrets.md](docs/secrets.md).

## Logging

Rowdy's lines follow the Lambda platform's own (`START RequestId: … Version: 47`), so they read as
one stream: the level, the invocation's `RequestId` while one is being served, the component, the
message, then `Key: value` pairs. No timestamp; the log collector adds its own.

```
INFO Rowdy Started Version: 0.1.0
START RequestId: 4a43db8d-4950-44f7-b92a-eb1cef487d8b Version: 47
INFO RequestId: 4a43db8d-4950-44f7-b92a-eb1cef487d8b Request Method: POST Path: /api/db
DEBUG RequestId: 4a43db8d-4950-44f7-b92a-eb1cef487d8b Vfs Flushed Key: db/nuss.sqlite Size: 4710400
WARN RequestId: 4a43db8d-4950-44f7-b92a-eb1cef487d8b Http Upstream Error Status: 502 Error: read ECONNRESET
INFO RequestId: 4a43db8d-4950-44f7-b92a-eb1cef487d8b Result Success: true Bytes: 214 Duration: 4632.24 ms
END RequestId: 4a43db8d-4950-44f7-b92a-eb1cef487d8b
```

At `info` a request is its method and path and a result is its status, outcome, size and duration;
headers (masked), the routing table and per-subsystem detail are at `debug`.

The command's own output is relayed a line at a time in the same shape, with the stream it came
from as the component (`INFO RequestId: … Stdout ready on :3000`). It is never filtered by level or
reworded, and a line that is already JSON is passed through untouched.

| Setting                          | Values                                    | Default |
| -------------------------------- | ----------------------------------------- | ------- |
| `ROWDY_LOG_LEVEL`, `--log-level` | `error`, `warn`, `info`, `debug`, `trace` | `info`  |
| `ROWDY_LOG_FORMAT`               | `text`, `json` (one object per line)      | `text`  |

`ROWDY_DEBUG=true` / `--debug` and `ROWDY_TRACE=true` / `--trace` still work as aliases for the
`debug` and `trace` levels; an explicit `ROWDY_LOG_LEVEL` wins over them. `ROWDY_LOG_FORMAT=json` is for
machines: the text format is meant to be read, not parsed. `rowdy create` deploys the
function at the level it was run with; in the GitHub Action, set `ROWDY_LOG_LEVEL` under `env:`.

Levels mean the same thing everywhere, so `warn` and `error` can be alerted on:

| Level   | Used for                                                                                     |
| ------- | -------------------------------------------------------------------------------------------- |
| `error` | rowdy could not do what was asked: a failed deploy, a command that failed, a lost response   |
| `warn`  | degraded or unexpected, but handled: an unreadable routes file, a skipped secret, a deadline |
| `info`  | lifecycle, and one line per request and per result                                           |
| `debug` | decisions and upstream calls: routing, VFS operations, AWS calls, headers (masked)           |
| `trace` | per-call detail, including every traced method's arguments and timing                        |

Conditions that are expected in normal operation, such as the health probe failing before the app
listens or a file missing just before it is created, are `debug`, so a healthy cold start and a
request emit no `warn` or `error`.

Values that look like credentials are never written in full, at any level: environment values,
headers and query parameters with credential-like names, URL passwords and AWS SDK payloads are
masked to their length and a short prefix and suffix (`ghp_…wxyz (40 chars)`). Request and response
bodies are not logged, only sized.

## Out of scope

The local runtime (no `AWS_LAMBDA_RUNTIME_API`) ignores `spec.crontab` and never starts the
command, so `spec.volumes` only takes effect on a deployed function.
