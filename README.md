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
record, a CDN origin, a smoke test) learns where the function lives.

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
| `secrets` | no       |                          | Secrets to inject as environment variables. `${{ toJSON(secrets) }}` passes the repository's, minus `github_token`. Alpha.                                      |

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
an optional HTTP method, and a URI:

```yaml
apiVersion: rowdy.run/v1alpha1
kind: Routes
spec:
  default: 'http://localhost:3000/'
  crontab:
    - '*/15 * * * * POST http://localhost:3000/tunnel/gc'
```

```
<minute> <hour> <day-of-month> <month> <day-of-week> [METHOD] <uri>
```

- Five crontab fields, with `*`, lists, ranges and `*/n` steps. Schedules run in UTC.
- `METHOD` defaults to `GET`, and may be any of `GET POST PUT PATCH DELETE HEAD OPTIONS`.
- `<uri>` is a backend URI (`http://`, `https://` or `rowdy://`). It resolves the way a route
  target does, not as a path through `spec.paths`.
- A line whose schedule starts with `cron(` or `rate(` goes to EventBridge verbatim, for anything
  crontab syntax cannot express.

On AWS, each line becomes an EventBridge Scheduler schedule inside a schedule group named after
the function, targeting the function's alias so that redeploys are picked up without touching the
schedule. Removing a line removes its schedule; removing every line removes the group. Schedules
do not retry, since the next tick is the retry.

A line rowdy cannot parse, or one EventBridge cannot express (a schedule that sets both a
day-of-month and a day-of-week, for instance), fails the deploy with the line quoted in the error.

### `X-Rowdy-Cron`

A scheduled request reaches the backend with `X-Rowdy-Cron` set to the line that triggered it.
Rowdy strips any inbound `X-Rowdy-Cron` from Function URL requests, and the function's public
invoke permission is conditioned on `InvokedViaFunctionUrl`, so raw invocations can only come from
an in-account IAM principal. An app can therefore treat the header as proof that the request came
from one of its own schedules, without a shared secret.

The runtime also refuses any line absent from its own deployed `spec.crontab`, so a schedule that
reconciliation left behind cannot do anything.

A scheduled request that comes back `>= 400` fails the invocation, which puts it in the function's
`Errors` metric and in CloudWatch.

### Worked example: tunnel.pizza

[tunnel-pizza/tunnel.pizza](https://github.com/tunnel-pizza/tunnel.pizza) is a Next.js app in a
container with a garbage-collection endpoint. It used to run GC from a GitHub `schedule:` workflow,
which landed about once every two hours against four slots an hour. It now runs from a crontab
line, and the first EventBridge tick swept the backlog on time.

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

<!-- prettier-ignore -->
```ts
/**
 * Rowdy sets X-Rowdy-Cron on requests it originates from a spec.crontab
 * schedule and strips it from every Function URL request, so a public caller
 * cannot supply it. A raw invocation that bypasses the Function URL needs an
 * in-account IAM principal, since the public invoke permission is conditioned
 * on InvokedViaFunctionUrl. Presence alone is therefore proof the request came
 * from one of this deployment's own schedules.
 */
export function fromRowdyCron(headers: Headers): boolean {
  return headers.has("x-rowdy-cron");
}
```

And the route that consumes it, from
[`src/app/tunnel/gc/route.ts`](https://github.com/tunnel-pizza/tunnel.pizza/blob/402e678/src/app/tunnel/gc/route.ts#L29-L33):

```ts
export async function POST(req: NextRequest) {
  if (!fromRowdyCron(req.headers)) {
    const auth = await authorizeAdmin(req.headers.get('authorization'));
    if (!auth.ok) return unauthorized(auth.reason);
  }
  // ... sweep
}
```

The deploy produced a schedule group `tunnel-pizza_tunnel_pizza` (the function name) holding one
schedule, `b28ee4ea25ca3975` (content-addressed from the line), with `cron(*/15 * * * ? *)` in
`UTC`, `FlexibleTimeWindow: OFF`, `MaximumRetryAttempts: 0`, targeting the function's alias with
this input:

```json
{
  "apiVersion": "rowdy.run/v1alpha1",
  "kind": "Cron",
  "spec": { "line": "*/15 * * * * POST http://localhost:3000/tunnel/gc" }
}
```

### Verifying a deploy

The schedule is visible with the AWS CLI, and a forged header proves the strip:

```sh
aws scheduler list-schedules --group-name <function-name>

curl -si -X POST -H 'x-rowdy-cron: forged' https://<your-app>/<your-cron-path>
```

The expected answer is whatever the endpoint returns to an unauthenticated caller. If it answers
the same with the header as without, the header never reached the app. The function's logs show
the same thing from the inside, at debug level, which the Action enables by default:
`Received invocation` lists the inbound headers, and `Local Http Proxy` lists what was forwarded.

For tunnel.pizza, the app's own status feed was the final check: managed tunnels went 14 to 8 at
the first tick, with no other sweep running.

### Deployer permissions

Alongside its existing Lambda, IAM and ECR permissions, the role the deploy assumes
(`AWS_ROLE_ARN` in the GitHub Action) needs:

- `scheduler:CreateScheduleGroup`
- `scheduler:GetScheduleGroup`
- `scheduler:DeleteScheduleGroup`
- `scheduler:TagResource`
- `scheduler:ListSchedules`
- `scheduler:GetSchedule`
- `scheduler:CreateSchedule`
- `scheduler:UpdateSchedule`
- `scheduler:DeleteSchedule`
- `iam:PassRole` on the function's execution role

The deployed function is granted `scheduler:*` when the Container Runtime Interface is enabled
with `--cri`.

## Volumes (experimental)

`spec.volumes` gives the app a writable, persistent directory that is not part of the image. Each
entry is `<scheme>://<locator>:<mountpoint>[:<flags>]`:

```yaml
spec:
  default: 'http://localhost:3000/'
  volumes:
    - 'file:///tmp/vfsstore:/vfs'
```

`file://<dir>` backs the mountpoint with a directory on the function's `/tmp` (persists across warm
invocations of one execution environment). `s3://<bucket>[/<prefix>]` backs it with a bucket: objects
are downloaded into `/tmp/vfsstore` the first time the app opens them, directory listings come from
the bucket, and files are uploaded when the app closes or fsyncs them. The upload is conditional on
the object's ETag, so if something else changed the object meanwhile the app's `close()` fails with
`ESTALE` instead of overwriting it. The deploy grants the execution role `s3:ListBucket` on the
bucket and `Get`/`Put`/`DeleteObject` on the prefix; the bucket itself must already exist.

Every entry is mounted. Mountpoints must be distinct; one may sit inside another, in which case the
inner volume owns its subtree. A rename from one volume to another fails with `EXDEV`, as it does
across filesystems, and tools such as `mv` fall back to copy and delete.

Several function instances can share an `s3://` volume. Reads re-check the object's ETag (at most
every 2 s) and pick up other instances' writes; programs that take advisory locks (SQLite, lockfile
libraries) get a lease in the bucket for the duration of the lock, so their transactions serialize
across instances and a contended lock shows up as `EAGAIN`/`SQLITE_BUSY` to retry. For plain files
the lease is opt-in: the `lock` flag (`s3://<bucket>:/mnt:lock`) holds it across each
open-for-write/close window; without it a conflicting write fails `close()` with `ESTALE` instead
of waiting. Design and trade-offs:
[ADR 0001](https://github.com/scaffoldly/rowdy/blob/vfs/docs/adr/0001-multi-writer-leases.md).

Flags follow the mountpoint, docker `-v` style, separated by commas (outside braces):

- `lock` — lease every open-for-write/close window (above).
- `local=<glob>` — files matching the glob (relative to the mountpoint; a glob without `/` matches a
  file name at any depth) stay in the backing directory and never reach the store. For scratch and
  sidecar files that must not be shared, e.g. SQLite's rollback journal:
  `s3://<bucket>:/s3:local=*-{journal,wal,shm}`. Repeat the flag for more globs.

Nothing is mounted in the kernel sense. The Lambda sandbox denies every kernel-mediated option
(`/dev/fuse`, `mount(2)`, namespaces, ptrace, seccomp-notify), so rowdy writes the
[`@scaffoldly/rowdy-vfs`](https://github.com/scaffoldly/rowdy/tree/vfs) shim to
`/tmp/rowdy/vfspreload.so` and prepends it to the app's `LD_PRELOAD`. The libc path calls the app
makes (`open`, `stat`, `opendir`, `rename`, `getcwd`, `realpath`, …) are rewritten in-process to the
backing directory, and the shim reports what it does to rowdy over a local unix socket
(`VFS_SOCKET`) so the backing store can be populated and persisted. Rowdy's own process is never
preloaded; an existing `LD_PRELOAD` is kept.

Limits of the preload model:

- Only dynamically linked musl (alpine) binaries that go through libc see the mountpoint. Static
  binaries and Go programs that issue raw syscalls do not.
- `mmap` of a file under the mountpoint is not translated; neither are `nftw`, `glob`, or
  `posix_spawn` paths.
- It is not a mountpoint, so a process started outside rowdy cannot see it.

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
function at the level it was run with, and the GitHub Action takes it as the `log-level` input.

Values that look like credentials are never written in full, at any level: environment values,
headers and query parameters with credential-like names, URL passwords and AWS SDK payloads are
masked to their length and a short prefix and suffix (`ghp_…wxyz (40 chars)`). Request and response
bodies are not logged, only sized.

## Out of scope

The local runtime (no `AWS_LAMBDA_RUNTIME_API`) ignores `spec.crontab` and never starts the
command, so `spec.volumes` only takes effect on a deployed function.
