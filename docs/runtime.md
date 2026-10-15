# Runtime environment

rowdy sets five variables in the command's environment. They tell the app how it is being
reached: the host and scheme a request came in on, the client's user agent, and the sandbox's own
private address.

| Variable           | Outside a request                                          | From a Function URL request                        | From a scheduled request                                       |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| `HTTP_HOST`        | `localhost`                                                | the `Host` header, else `localhost`                | the line's URI host, with any port                             |
| `HTTP_HOSTNAME`    | `localhost`                                                | `X-Forwarded-Host`, else `HTTP_HOST`               | the line's URI host, without port                              |
| `HTTP_PROTO`       | `http`                                                     | `X-Forwarded-Proto`, else `https`                  | the line's URI scheme                                          |
| `HTTP_UA`          | `<rowdy>/<version>`                                        | `<User-Agent> (<rowdy> v<version> LambdaPipeline)` | `<rowdy>/<version> (cron) (<rowdy> v<version> LambdaPipeline)` |
| `NET_PRIVATE_IPV4` | the sandbox's private IPv4 address; unset when it has none | unchanged                                          | unchanged                                                      |

`<rowdy>` is the package name, `@scaffoldly/rowdy`. A request without a `User-Agent` header uses
`<rowdy>/<version>` in its place. Header names are matched in either their canonical or lower-case
spelling.

For example, a first request of `curl https://app.example/` through a proxy that sets
`X-Forwarded-Host` and `X-Forwarded-Proto`, in front of a Function URL:

```
HTTP_HOST=abc123.lambda-url.us-east-1.on.aws
HTTP_HOSTNAME=app.example
HTTP_PROTO=https
HTTP_UA=curl/8.7.1 (@scaffoldly/rowdy v0.1.0 LambdaPipeline)
NET_PRIVATE_IPV4=<the sandbox's private IPv4 address>
```

A schedule line `*/15 * * * * POST http://localhost:3000/tunnel/gc` (see
[crontab.md](crontab.md)) gives `HTTP_HOST=localhost:3000`, `HTTP_HOSTNAME=localhost` and
`HTTP_PROTO=http`.

## When they are set

The command starts once per sandbox, and its environment is fixed when it starts. rowdy starts it
on the sandbox's first invocation, after taking these values from that invocation. They describe
that first request for as long as the sandbox lives: later requests, even ones on another host
name, do not change what the running command sees.

So read them as "how this instance was first reached", not as per-request values. Per-request
host, scheme and user agent are in each request's own headers, which rowdy passes to the app.

The defaults in the first column are set when rowdy starts and apply only until the first
invocation replaces them. Outside Lambda (no `AWS_LAMBDA_RUNTIME_API`) no invocation ever arrives,
the environment is never finalized, and the command does not start.

## Precedence

rowdy's values replace variables of the same name from the image, the function's configuration or
`--secrets`. The command always sees rowdy's.

## Logging

At `debug`, each value is logged as rowdy takes it, and the command's whole environment is logged
once, as it starts:

```
DEBUG Received Environment Variable Name: HTTP_HOST Value: abc123.lambda-url.us-east-1.on.aws
DEBUG Received Environment Variable Name: HTTP_UA Value: curl/8.7.1 (@scaffoldly/rowdy v0.1.0 LambdaPipeline)
DEBUG Environment Variables Finalized Env: [PATH=/…n (21 chars), …, HTTP_HOST=abc123.lambda-url.us-east-1.on.aws, …]
```

These five are logged in full. Every other environment value is masked to its length and a short
prefix and suffix, as described under Logging in the [README](../README.md#logging).

`Received Environment Variable` lines appear on every invocation, but only the values from the
first one reach the command; the `Environment Variables Finalized` line shows what it got.
