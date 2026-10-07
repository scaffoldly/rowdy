# CORS

`spec.cors` sets cross-origin resource sharing per path. Each key is a path pattern, written the
same way as the keys in `paths`. Each value is either `none` or a policy. rowdy uses the first
pattern that matches the request path. A path no pattern matches is treated as `none`.

```yaml
apiVersion: rowdy.run/v1alpha1
kind: Routes
spec:
  default: 'http://localhost:3000/'
  cors:
    '/oauth{/*path}': none
    '/api{/*path}':
      origins: ['https://app.example']
      methods: [GET, POST, DELETE]
      headers: [content-type, authorization]
      expose: [x-request-id]
      credentials: true
      maxAge: 600
```

The `apiVersion` / `kind` / `spec` wrapper is optional, so this works inline in the GitHub Action:

```yaml
- uses: scaffoldly/rowdy@github
  with:
    routes: |
      default: "http://localhost:3000/"
      cors:
        "/api{/*path}":
          origins: ["https://app.example"]
          credentials: true
```

## `none`

With `none`, rowdy does not handle CORS for the path. Preflights go to the app, and the app's own
`Access-Control-*` headers come back unchanged. Use it for an app that sets its own CORS headers.

## Policy

| Key           | Default | Meaning                                                                                     |
| ------------- | ------- | ------------------------------------------------------------------------------------------- |
| `origins`     | —       | Required. Origins that are allowed, as `scheme://host[:port]`, `null`, or `*`.              |
| `methods`     | `[*]`   | Methods a preflight allows.                                                                 |
| `headers`     | `[*]`   | Request headers a preflight allows.                                                         |
| `expose`      | `[]`    | Response headers the browser shows to the calling script (`Access-Control-Expose-Headers`). |
| `credentials` | `false` | Sends `Access-Control-Allow-Credentials: true`, so the browser includes cookies.            |
| `maxAge`      | unset   | Seconds a browser may cache the preflight (`Access-Control-Max-Age`).                       |

On a path with a policy, rowdy handles CORS itself:

- **Preflight** (an `OPTIONS` request with `Origin` and `Access-Control-Request-Method`): rowdy
  replies `204` without calling the app. An allowed origin gets the allow headers. Any other
  origin gets no `Access-Control-*` headers, and the browser blocks the request.
- **Every other request:** rowdy removes all `Access-Control-*` headers the app sent. If the
  origin is allowed, it adds its own. `Vary: Origin` is always added.

### `*` and credentials

`origins: ['*']` without `credentials` sends a literal `*`. Browsers then send no cookies.

`origins: ['*']` together with `credentials: true` makes rowdy echo whatever `Origin` the request
carries, with `Access-Control-Allow-Credentials: true`. With credentials, `*` in `methods` or
`headers` echoes the requested method or headers too. This lets any site make authenticated
requests with the visitor's cookies and read the responses. Only set it on a path that is meant to
be called that way.

## Function URL

rowdy deploys the Function URL with no CORS configuration, and clears any it set before. A
Function URL's CORS applies to every path. Lambda also adds those headers on top of the app's own,
which gives two `Access-Control-Allow-Origin` values that browsers reject. Use `spec.cors` instead.

## Migrating from the any-origin default

Earlier versions configured the Function URL to allow every origin with credentials, on every
path. From this version, a deployment with no `spec.cors` gets no CORS handling from rowdy. A
browser on another origin can call the app only if the app sends its own CORS headers.

To allow any origin without cookies:

```yaml
cors:
  '{/*path}':
    origins: ['*']
```

To keep the old behavior exactly (any origin, with cookies, any method, preflights cached for an
hour):

```yaml
cors:
  '{/*path}':
    origins: ['*']
    expose: ['*']
    credentials: true
    maxAge: 3600
```
