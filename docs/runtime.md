# Runtime environment

How an image becomes a running Lambda function under rowdy: rowdy is added to the image as a layer
on its way into ECR, the function is configured to start rowdy with the image's `ENTRYPOINT` and
`CMD` as its command, and rowdy runs that command with a few variables of its own.

## rowdy is added as a layer

`rowdy create aws lambda <image>` (and the GitHub Action, which runs it) does not deploy the image
from where it was pushed. Lambda runs container images only from ECR, so rowdy copies the image into
the deploying account's ECR, and adds itself on the way.

- **Where it goes.** The registry is `AWS_ECR_REGISTRY` (or `--registry`), else the deploying
  account's `<account>.dkr.ecr.<region>.amazonaws.com`. The repository is the image's own
  `namespace/name`, for example `cnuss/headscale`, created if it does not exist.
- **How it is copied.** Blob by blob, registry to registry: manifests, configs and layers are read
  from the source and pushed to ECR. Nothing is pulled into a local Docker daemon. A private source
  image is read with the credentials `docker login` saved for its registry. An image named without a
  registry (`nginx`) is read from `mirror.gcr.io`. The source for rowdy's own layers,
  `ghcr.io/scaffoldly/rowdy:beta`, is public.
- **What is added.** For each platform (`os`/`architecture`) that both the image and
  `ghcr.io/scaffoldly/rowdy:beta` publish, rowdy's layers are appended on top of the image's own.
  That is one layer holding a single file, `/usr/local/bin/rowdy`. The binary is statically linked,
  so it runs on any base: distroless, scratch, Alpine, Debian. A platform rowdy does not publish is
  copied unchanged. Images given with `--layers-from` add their one layer before rowdy's; see
  [Your own layers](#your-own-layers).
- **What changes in the config.** Only what the new layer needs: its uncompressed digest is appended
  to `rootfs.diff_ids` and rowdy's build history to `history`. `ENTRYPOINT`, `CMD`, `ENV`,
  `WORKDIR` and `USER` stay as they were built. The config and manifests are rehashed, so the copy
  in ECR has its own digests, not the source's.
- **What is dropped.** Attestation manifests (provenance, SBOMs). They describe the image as built,
  which the copy no longer is.

The function runs the `linux/amd64` copy, by digest: its image URI is
`<registry>/<namespace>/<name>@sha256:…`, and its architecture is `x86_64`. An image without a
`linux/amd64` variant fails to deploy with `Unable to find image for platform: linux/amd64`.

### Your own layers

`--layers-from <image>` (repeatable, or `ROWDY_LAYERS_FROM`, one per line) adds another image's
layer the same way, so a tool is on the deployed image without
the app's Dockerfile installing it:

```sh
rowdy create aws lambda ghcr.io/owner/app:latest --layers-from ghcr.io/tunnel-pizza/tunneld:latest
```

The layers go on in the order given, then rowdy's last, so `/usr/local/bin/rowdy` is always rowdy's.
A repeated image is added once, and naming rowdy's own image adds nothing. A source is read
anonymously, never with the app image's registry credentials, so it must be public.

A source must be built like rowdy's own final stage: `FROM scratch`, one `COPY` of a static binary,
an `ENTRYPOINT`. On every platform it publishes, before anything is copied, rowdy checks:

- one layer, and one entry in `rootfs.diff_ids`;
- a `history`, whose one non-empty entry is a `COPY` or `ADD`;
- no other step but `ENTRYPOINT`, `CMD` or `LABEL`: no `RUN`, `ENV`, `ARG`, `USER`, `WORKDIR` and the
  like;
- no `Env` but buildkit's default `PATH`.

A source that breaks any of them fails the deploy, naming the image, the platform and the rule:

```
layers-from ghcr.io/owner/tool:latest (linux/amd64): 2 layers; a layers-from image must be one layer, as rowdy's is (FROM scratch, one COPY, ENTRYPOINT)
```

The layer's size and files are not inspected. rowdy's own image is built by this repository and
is not checked. A platform a source does not publish is copied
without it, with a `Layers Skipped` warning.

## `ENTRYPOINT` and `CMD`

rowdy sets the function's image configuration, which overrides the image's own:

| Lambda setting     | Value                                                                   |
| ------------------ | ----------------------------------------------------------------------- |
| `EntryPoint`       | `["/usr/local/bin/rowdy", "--"]`                                        |
| `Command`          | the image's `ENTRYPOINT` followed by its `CMD`, or the command you give |
| `WorkingDirectory` | `/`                                                                     |

So Lambda starts rowdy, and everything after `--` is the command rowdy runs. An image built with

```dockerfile
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
```

runs as `/usr/local/bin/rowdy -- docker-entrypoint.sh node server.js`.

- **Overriding it.** `rowdy create aws lambda <image> <command...>`, or the Action's `command`
  input, replaces both `ENTRYPOINT` and `CMD`. The Action's input is split into words by the shell,
  so quote an argument that contains spaces.
- **Each deploy reads the image again.** Without an override, `Command` is taken from the image
  being deployed, so a changed `CMD` takes effect on the next deploy, and removing an override goes
  back to the image's.
- **`ENV`.** The image's variables are also written into the function's environment, except any
  that the same deploy sets itself (its log level, `--secrets`, the routes).
- **`WORKDIR`.** Lambda does not run the image as its `USER`; it uses a user of its own. So it
  starts rowdy in `/`, and rowdy changes to the image's `WORKDIR`, passed as `ROWDY_WORKDIR`. If
  that user cannot enter it (distroless `:nonroot`'s `/home/nonroot` is mode `0700`), rowdy logs
  `Working Directory Unavailable` and stays in `/`.
- **CRI.** With `--cri`, `EntryPoint` is `["/usr/local/bin/rowdy", "serve", "--"]`: rowdy also
  serves its gRPC API on port 7939.

## How rowdy runs the command

rowdy is the function's runtime: it asks the Lambda Runtime API (`AWS_LAMBDA_RUNTIME_API`) for each
invocation, routes it to the app (see [Routes](../README.md#routes)), and returns the app's
response.

- **Start.** On the sandbox's first invocation, rowdy finalizes the command's environment (see
  [Variables](#variables)) and starts the command as a child process. The program is looked up on
  `PATH` and run directly, not through a shell: what the image config stores is what runs. A
  shell-form `CMD node server.js` is stored as `["/bin/sh", "-c", "node server.js"]`, so it needs
  `/bin/sh` in the image.
- **Lifetime.** One command per sandbox. It keeps running across invocations; Lambda freezes the
  whole sandbox between them.
- **Output.** stdout and stderr are relayed into the function's log a line at a time (see
  [Logging](../README.md#logging)).
- **Exit.** When the command exits, rowdy logs `Command Completed`, takes no new invocations, lets
  the ones in flight answer, and exits with the command's exit code; a non-zero code forces the exit
  2 seconds after that. The next invocation gets a fresh sandbox and a fresh start. A non-zero exit
  is logged at `error` as `Command Exited`, with the code or signal, uptime, memory and the last
  request, followed by the command's last lines of output. With `--cri`, rowdy keeps serving after
  the command exits.
- **Volumes.** With `spec.volumes`, rowdy adds its file system shim to the command's `LD_PRELOAD`;
  see [volumes.md](volumes.md).

## Variables

rowdy sets seven variables in the command's environment. They tell the app how it is being
reached: the origin, host, port and scheme a request came in on, the client's user agent, and the
sandbox's own private address.

| Variable           | Outside a request                                          | From a Function URL request                                                      | From a scheduled request                                       |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `HTTP_HOST`        | `localhost`                                                | the `Host` header: always the Function URL's own domain                          | the line's URI host, with any port                             |
| `HTTP_HOSTNAME`    | `localhost`                                                | the [forwarded host](#forwarded-headers-and-spechosts) if used, else `HTTP_HOST` | the line's URI host, without port                              |
| `HTTP_ORIGIN`      | `http://localhost`                                         | `<HTTP_PROTO>://<HTTP_HOSTNAME>`, with any non-default port                      | built the same way                                             |
| `HTTP_PORT`        | `80`                                                       | the port in `HTTP_HOSTNAME`, else the default for `HTTP_PROTO`                   | the line's URI port, else the default for its scheme           |
| `HTTP_PROTO`       | `http`                                                     | the forwarded scheme if used, else `https`                                       | the line's URI scheme                                          |
| `HTTP_UA`          | `<rowdy>/<version>`                                        | `<User-Agent> (<rowdy> v<version> LambdaPipeline)`                               | `<rowdy>/<version> (cron) (<rowdy> v<version> LambdaPipeline)` |
| `NET_PRIVATE_IPV4` | the sandbox's private IPv4 address; unset when it has none | unchanged                                                                        | unchanged                                                      |

`<rowdy>` is the package name, `@scaffoldly/rowdy`. A request without a `User-Agent` header uses
`<rowdy>/<version>` in its place. Header names are matched in any case. The default port is `443`
for `https` and `80` for `http`.

`HTTP_ORIGIN` is the app's public origin, as a browser would write it: `<scheme>://<host>[:<port>]`,
with no path and no trailing slash. It is the value to use for a server URL, a base URL or an OAuth
redirect base. The host is lower-cased, and the port is left out when it is the scheme's default.

A request straight to the Function URL gives:

```
HTTP_HOST=abc123.lambda-url.us-east-1.on.aws
HTTP_HOSTNAME=abc123.lambda-url.us-east-1.on.aws
HTTP_ORIGIN=https://abc123.lambda-url.us-east-1.on.aws
HTTP_PORT=443
HTTP_PROTO=https
HTTP_UA=curl/8.7.1 (@scaffoldly/rowdy v0.1.0 LambdaPipeline)
NET_PRIVATE_IPV4=<the sandbox's private IPv4 address>
```

The same request for `https://app.example/` through a CDN that sends `X-Forwarded-Host: app.example`,
with `app.example` in `spec.hosts`, gives `HTTP_HOSTNAME=app.example` and
`HTTP_ORIGIN=https://app.example`; `HTTP_HOST` is still the Function URL's.

A schedule line `*/15 * * * * POST http://localhost:3000/tunnel/gc` (see
[crontab.md](crontab.md)) gives `HTTP_HOST=localhost:3000`, `HTTP_HOSTNAME=localhost`,
`HTTP_PORT=3000`, `HTTP_PROTO=http` and `HTTP_ORIGIN=http://localhost:3000`. A schedule is declared
in the manifest, so its values are always used.

### Forwarded headers and `spec.hosts`

A CDN or proxy in front of the Function URL connects to it with the Function URL's own `Host`; Lambda
refuses any other. The host and scheme the visitor used reach rowdy only in forwarded headers, and
anyone can send those, straight to the Function URL. The values are fixed from the sandbox's first
invocation, so a forged header on that one request would set the app's public origin for the
sandbox's whole life. List the public origins, and rowdy uses forwarded values only for them:

```yaml
spec:
  default: 'http://localhost:3000/'
  hosts:
    - app.example # https://app.example
    - 'http://legacy.app.example:8080'
    - '*.preview.app.example' # https://preview.app.example, https://<label>.preview.app.example
```

An entry is a host, which means `https` on port 443, or an `http(s)://host[:port]` origin with no
path. A leftmost label of `*` stands for the host under it and any one label there; `**` for the
host under it and any number of labels: `*.app.example` lists `https://app.example` and
`https://www.app.example`, `**.app.example` also `https://a.b.app.example`. On each request, rowdy builds the origin the forwarded headers describe:

- **With `spec.hosts`:** the forwarded values are used only if that exact origin is listed: host,
  scheme and port. Otherwise they are ignored, and the request is described by the Function URL
  itself (`https`, port 443). A forged header can then only name one of your own origins.
- **Without `spec.hosts`:** the forwarded values are used unchecked, and the first request that
  uses them logs a warning, once per sandbox:

  ```
  WARN Lambda Forwarded Host Unchecked Cdn: proxy Origin: https://app.example Reason: spec.hosts is empty, so any caller can set HTTP_HOSTNAME and HTTP_ORIGIN; list the public origins
  ```

A request straight to the Function URL carries no forwarded headers, so `spec.hosts` never turns it
away: it is described by the Function URL itself, listed hosts or not.

#### The headers the app gets

rowdy replaces `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-Port` on every
request with how the request reached the deployment, as decided above. A listed host reaches the app
as itself; an unlisted or forged one, or a direct request, reaches it as the Function URL over https.
`X-Forwarded-For` is passed on as sent.

So with `spec.hosts`, an app can infer its public URL from the request without being told it: Auth.js
with `trustHost: true` and no `AUTH_URL`, or Next.js's `request.url`, only ever see a listed origin
or the Function URL's own. Without `spec.hosts`, the forwarded values reach the app unchecked.

`Forwarded` carries the chain, client-most first: the elements the request arrived with, as sent;
one for the CDN or proxy hop's claims (`for=` the visitor's address, `host=`, `proto=`,
`by=_cloudfront`, `_cloudflare` or `_proxy`); and rowdy's own, last (`for=` the address that
connected to the Function URL, `host=` and `proto=` as decided, `by=_rowdy`). Only the last element
is rowdy's verdict, and it always matches `X-Forwarded-Host` and `-Proto`; the others are claims an
app can inspect, and refuse a request whose claimed `host=` differs from the verdict's.

```
# Through CloudFront, with *.app.example listed
Forwarded: for=198.51.100.7;host=www.app.example;proto=https;by=_cloudfront, for=130.176.1.2;host=www.app.example;proto=https;by=_rowdy

# Straight to the Function URL with X-Forwarded-Host: evil.example
Forwarded: host=evil.example;by=_proxy, for=203.0.113.9;host=abc.lambda-url.us-east-1.on.aws;proto=https;by=_rowdy
```

A missing claim proves nothing, and `by=_cloudfront` or `_cloudflare` is inferred from headers
anyone can send; the verdict is what `spec.hosts` constrains.

#### Several hosts on one deployment

Every listed host is trusted, but `HTTP_HOSTNAME` and `HTTP_ORIGIN` still describe only the
sandbox's first request. With `oidc.to` and `anotherbrand.com` on one deployment, a sandbox first
reached through `oidc.to` reports `HTTP_ORIGIN=https://oidc.to` for its whole life, including to
requests that came through `anotherbrand.com`. Anything built from them, such as redirect URLs, an
issuer or a cookie domain, then names the wrong host.

To serve each host as itself, either:

- **Read the host per request.** `Host` and `X-Forwarded-*` describe each request, checked against
  `spec.hosts` (see above), so the app can build URLs from them instead of `HTTP_ORIGIN`.
- **Deploy once per host.** A different `name` gives each host its own function, so its sandboxes
  only ever see that host.

#### Writing the deployment's state to the CDN

`spec.hosts` can also be a map from each public host to a target: where a deploy writes the
deployment's state for the CDN in front of that host, so an edge function can find the Function URL
without being told it. An empty value names no target; the keys are the list above.

```yaml
spec:
  hosts:
    '*.oidc.to': arn:aws:cloudfront::123456789012:key-value-store/706d9bf2-5c29-4b7c-8900-89eb32d9723d
    legacy.example: ''
```

The state is one key per value the deploy produced: `FunctionUrl`, `FunctionArn`, `AliasArn`,
`FunctionVersion`, `Qualifier`, `ImageUri`, `RoleArn`, `RoleId`, `RoleName` and, with a managed
bucket, `Bucket`. No environment variable or secret is written.

```js
// A CloudFront Function on viewer request
import cf from 'cloudfront';
const kvs = cf.kvs();
async function handler(event) {
  const domainName = (await kvs.get('FunctionUrl')).split('/')[2]; // abc.lambda-url.us-east-1.on.aws
  event.request.headers['x-forwarded-host'] = { value: event.request.headers.host.value };
  cf.updateRequestOrigin({ domainName });
  return event.request;
}
```

rowdy recognizes the target by its shape:

| Target                         | Written to                                         |
| ------------------------------ | -------------------------------------------------- |
| a CloudFront KeyValueStore ARN | the store, for `cf.kvs()` in a CloudFront Function |

A deploy puts only the keys whose values changed, after the Function URL is in place, and never
deletes a key, so keys others put in the store survive. The deploying credentials need
`cloudfront-keyvaluestore:ListKeys`, `DescribeKeyValueStore` and `UpdateKeys` on the store. Hosts
that name the same target share it: it is written once per deploy.

rowdy first infers the CDN from its own headers: CloudFront by `X-Amz-Cf-Id` or
`CloudFront-Forwarded-Proto`, Cloudflare by `CF-Ray` or `CF-Visitor`; anything else is treated as a
plain proxy. Neither CDN ever sets `Forwarded`, so behind one it can only be what the visitor sent,
and rowdy does not read it there.

| From          | Host                                                                                                                     | Scheme, in order                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| CloudFront    | `X-Forwarded-Host`, first value                                                                                          | `CloudFront-Forwarded-Proto`; `X-Forwarded-Proto`                              |
| Cloudflare    | `X-Forwarded-Host`, first value                                                                                          | `X-Forwarded-Proto`, which Cloudflare overwrites; `CF-Visitor: {"scheme":"…"}` |
| a plain proxy | `Forwarded: host=…` ([RFC 7239](https://www.rfc-editor.org/rfc/rfc7239)), first element; `X-Forwarded-Host`, first value | `Forwarded: proto=…`; `X-Forwarded-Proto`                                      |

The port is the one in the forwarded host, if any, else the scheme's default. `X-Forwarded-Port` is
not used.

None of these CDNs sends the visitor's host by default once its origin is a Function URL, because the
origin request has to carry the Function URL's `Host`. Configure the CDN to set `X-Forwarded-Host` to
the visitor's host, overwriting any the visitor sent: on CloudFront, for example, with a CloudFront
Function on viewer request; on Cloudflare, with a request header Transform Rule. On CloudFront, also
add `CloudFront-Forwarded-Proto` to the origin request policy if the site is served over `http`.

At `debug`, each request logs `Forwarded Host` with the CDN rowdy inferred, the origin the headers
described, and the decision: `listed` or `unchecked` (used), `unlisted` (ignored), or `absent` (no
forwarded host).

### When they are set

The command starts once per sandbox, and its environment is fixed when it starts. rowdy starts it
on the sandbox's first invocation, after taking these values from that invocation. They describe
that first request for as long as the sandbox lives: later requests, even ones on another host
name, do not change what the running command sees.

So read them as "how this instance was first reached", not as per-request values. Per-request
host, scheme and user agent are in each request's own headers, which rowdy passes to the app.

The defaults in the first column are set when rowdy starts and apply only until the first
invocation replaces them. Outside Lambda (no `AWS_LAMBDA_RUNTIME_API`) no invocation ever arrives,
the environment is never finalized, and the command does not start.

### Precedence

rowdy's values replace variables of the same name from the image, the function's configuration or
`--secrets`. The command always sees rowdy's.

### Logging

At `debug`, each value is logged as rowdy takes it, and the command's whole environment is logged
once, as it starts:

```
DEBUG Received Environment Variable Name: HTTP_HOST Value: abc123.lambda-url.us-east-1.on.aws
DEBUG Received Environment Variable Name: HTTP_UA Value: curl/8.7.1 (@scaffoldly/rowdy v0.1.0 LambdaPipeline)
DEBUG Environment Variables Finalized Env: [PATH=/…n (21 chars), …, HTTP_HOST=abc123.lambda-url.us-east-1.on.aws, …]
```

These seven are logged in full. Every other environment value is masked to its length and a short
prefix and suffix, as described under Logging in the [README](../README.md#logging).

`Received Environment Variable` lines appear on every invocation, but only the values from the
first one reach the command; the `Environment Variables Finalized` line shows what it got.
`HTTP_ORIGIN` is built as the environment is finalized, so it appears only in that line.
