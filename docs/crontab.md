# Scheduled requests

`spec.crontab` lets a deployment run itself on a schedule. Each line is a crontab schedule, an
optional HTTP method, and a backend URI; on each tick rowdy makes that request to the app inside
the container, as if it had arrived from outside.

```yaml
apiVersion: rowdy.run/v1alpha1
kind: Routes
spec:
  default: 'http://localhost:3000/'
  crontab:
    - '*/15 * * * * POST http://localhost:3000/tunnel/gc'
    - '0 4 * * MON http://localhost:3000/reports/weekly'
```

The `apiVersion` / `kind` / `spec` wrapper is optional, so the same lines work inline in the
GitHub Action:

```yaml
- uses: scaffoldly/rowdy@github
  with:
    cloud: aws
    compute: lambda
    name: ${{ github.repository }}
    image: ghcr.io/${{ github.repository }}:latest
    routes: |
      default: "http://localhost:3000/"
      crontab:
        - "*/15 * * * * POST http://localhost:3000/tunnel/gc"
```

## Line syntax

```
<minute> <hour> <day-of-month> <month> <day-of-week> [METHOD] <uri>
```

| Field          | Range                                    | Notes                                                  |
| -------------- | ---------------------------------------- | ------------------------------------------------------ |
| `minute`       | `0-59`                                   |                                                        |
| `hour`         | `0-23`                                   | Schedules run in UTC.                                  |
| `day-of-month` | `1-31`                                   |                                                        |
| `month`        | `1-12`, `JAN`–`DEC`                      |                                                        |
| `day-of-week`  | `0-7`, `SUN`–`SAT`                       | `0` and `7` are both Sunday, as in cron.               |
| `METHOD`       | `GET POST PUT PATCH DELETE HEAD OPTIONS` | Optional; defaults to `GET`.                           |
| `uri`          | `http://`, `https://`, `rowdy://`        | A backend URI. Exactly one; no body, no extra headers. |

Each field is a comma-separated list of `*`, a value, or a `from-to` range, each optionally
followed by `/step`. Names are case-insensitive.

The URI resolves the way a route target does, not as a path through `spec.paths`: it names the
backend directly. A `rowdy://` URI addresses rowdy's own endpoints (`rowdy://health/`, `rowdy://version/`).

### Passthrough

A schedule that starts with `cron(` or `rate(` goes to EventBridge Scheduler verbatim, for anything
crontab syntax cannot express:

```yaml
crontab:
  - 'rate(5 minutes) http://localhost:3000/heartbeat'
  - 'cron(0 12 L * ? *) POST http://localhost:3000/billing/close'
```

### What fails the deploy

A line that does not parse, or one EventBridge cannot express, fails the deploy with the line
quoted in the error rather than dropping the schedule:

- Fewer than five schedule fields, or a field out of range.
- More than one URI, or a URI with another scheme.
- A schedule that sets both a day-of-month and a day-of-week. EventBridge requires `?` in one of
  them; rowdy fills it in when the other is `*`, and refuses when both are set.

## On AWS

Each line becomes an EventBridge Scheduler schedule inside a schedule group named after the
function (both are limited to 64 characters over the same charset). The schedule:

- is named by the first 16 hex digits of the SHA-256 of the line, with the line as its description;
- runs in `UTC` with `FlexibleTimeWindow: OFF`;
- targets the function's **alias**, so a redeploy is picked up without touching the schedule;
- has `MaximumRetryAttempts: 0`. Scheduler's default retries for up to 24 hours, which is wrong for
  a recurring job: the next tick is the retry.

The deploy reconciles the group against `spec.crontab`: a changed line is a new schedule and the
old one is deleted, removing every line removes the group, and destroying the function deletes the
group with it. The function's execution role is given `scheduler.amazonaws.com` as a trusted
principal while any line exists, so the scheduler can invoke the alias.

The schedule delivers this input to the function:

```json
{
  "apiVersion": "rowdy.run/v1alpha1",
  "kind": "Cron",
  "spec": { "line": "*/15 * * * * POST http://localhost:3000/tunnel/gc" }
}
```

Rowdy parses the line again at invocation time and refuses one that is not in its own deployed
`spec.crontab` (`Undeclared Cron Event`), so a schedule left behind by a failed reconciliation
cannot do anything.

### Deployer permissions

Alongside its Lambda, IAM and ECR permissions, the role the deploy assumes (`AWS_ROLE_ARN` in the
GitHub Action) needs:

- `scheduler:CreateScheduleGroup`, `scheduler:GetScheduleGroup`, `scheduler:DeleteScheduleGroup`,
  `scheduler:TagResource`
- `scheduler:ListSchedules`, `scheduler:GetSchedule`, `scheduler:CreateSchedule`,
  `scheduler:UpdateSchedule`, `scheduler:DeleteSchedule`
- `iam:PassRole` on the function's execution role

The deployed function itself is granted `scheduler:*` only when the Container Runtime Interface is
enabled with `--cri`.

## The request the app sees

The scheduled request reaches the backend with:

- `X-Rowdy-Cron`: the line that triggered it.
- `User-Agent`: rowdy's, suffixed ` (cron)`.
- `Host`: the URI's host.
- No body, no cookies, no other headers.

### Trusting `X-Rowdy-Cron`

Rowdy strips any inbound `X-Rowdy-Cron` from Function URL requests, and the function's public
invoke permission is conditioned on `InvokedViaFunctionUrl`, so a raw invocation can only come from
an in-account IAM principal. The header's presence is therefore proof that the request came from
one of this deployment's own schedules, with no shared secret to rotate:

```ts
export function fromRowdyCron(headers: Headers): boolean {
  return headers.has('x-rowdy-cron');
}

export async function POST(req: NextRequest) {
  if (!fromRowdyCron(req.headers)) {
    const auth = await authorizeAdmin(req.headers.get('authorization'));
    if (!auth.ok) return unauthorized(auth.reason);
  }
  // ... do the work
}
```

A forged header proves the strip:

```sh
curl -si -X POST -H 'x-rowdy-cron: forged' https://<your-app>/<your-cron-path>
```

The expected answer is whatever the endpoint returns to an unauthenticated caller.

## Failures and observability

EventBridge ignores the response payload, so rowdy turns the response status into the invocation's
outcome: a request that comes back `>= 400` fails the invocation (`Cron request to <uri> failed
with status <n>`), which puts it in the function's `Errors` metric and in CloudWatch. A `2xx`/`3xx`
succeeds. There is no retry; the next tick is the retry.

In the function's log a scheduled invocation looks like any other, with the line in place of a
method and path:

```
INFO RequestId: … Request Cron: */15 * * * * POST http://localhost:3000/tunnel/gc
INFO RequestId: … Result Status: 200 Success: true Bytes: 17 Duration: 212.40 ms
```

`Unparseable Cron Event` and `Undeclared Cron Event` are the two ways an invocation is refused
before any request is made.

The schedules themselves:

```sh
aws scheduler list-schedules --group-name <function-name>
aws scheduler get-schedule --group-name <function-name> --name <schedule-name>
```

## Worked example: tunnel.pizza

[tunnel-pizza/tunnel.pizza](https://github.com/tunnel-pizza/tunnel.pizza) is a Next.js app in a
container with a garbage-collection endpoint. It used to run GC from a GitHub `schedule:` workflow,
which landed about once every two hours against four slots an hour. It now runs from the crontab
line above
([`.github/workflows/main.yml`](https://github.com/tunnel-pizza/tunnel.pizza/blob/402e678/.github/workflows/main.yml#L59-L76),
[`src/lib/auth.ts`](https://github.com/tunnel-pizza/tunnel.pizza/blob/402e678/src/lib/auth.ts#L65-L75)),
and the first EventBridge tick swept the backlog on time: managed tunnels went 14 to 8, with no
other sweep running.

The deploy produced a schedule group `tunnel-pizza_tunnel_pizza` holding one schedule,
`b28ee4ea25ca3975`, with `cron(*/15 * * * ? *)` in `UTC`, targeting the function's alias.
