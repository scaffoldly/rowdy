# Rowdy

Scaffoldly Serverless Router

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
    - '*/15 * * * * POST https://localhost:3000/tunnel/gc'
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
