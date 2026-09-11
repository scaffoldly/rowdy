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

## Out of scope

The local runtime (no `AWS_LAMBDA_RUNTIME_API`) ignores `spec.crontab`.
