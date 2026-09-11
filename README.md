# Rowdy GitHub Action

Deploys a container to AWS Lambda with a Function URL in front of it, and can run the container
on a schedule. This branch is the Action; the runtime, the `Routes` manifest and `spec.crontab`
are documented on [`main`](https://github.com/scaffoldly/rowdy/blob/main/README.md).

## Getting started

The Action needs an AWS role it can assume through OIDC, so the job requires `id-token: write` and
an `AWS_ROLE_ARN` in its environment:

```yaml
permissions:
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

## Inputs

| Input     | Required | Default                  | Description                                                                                                                                                                                                                      |
| --------- | -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud`   | yes      |                          | Cloud provider. `aws` today.                                                                                                                                                                                                     |
| `compute` | yes      |                          | Compute type. `lambda` today.                                                                                                                                                                                                    |
| `image`   | yes      |                          | Container image to deploy, such as `ghcr.io/owner/repo@sha256:…`.                                                                                                                                                                |
| `name`    | no       | random                   | Application name. Becomes the function name, sanitized.                                                                                                                                                                          |
| `command` | no       | image `ENTRYPOINT`+`CMD` | Override the command the container runs.                                                                                                                                                                                         |
| `memory`  | no       | `256`                    | Memory for the container, in megabytes.                                                                                                                                                                                          |
| `cri`     | no       | `false`                  | Enable the Container Runtime Interface.                                                                                                                                                                                          |
| `routes`  | no       |                          | Path to, or inline YAML/JSON of, a Routes manifest. Accepts a path, `file://`, `data:`, or the manifest inline. A bare spec is accepted. See [Routes](https://github.com/scaffoldly/rowdy/blob/main/README.md#routes) on `main`. |
| `secrets` | no       |                          | Secrets to inject as environment variables. `${{ toJSON(secrets) }}` passes the repository's, minus `github_token`. Alpha.                                                                                                       |

| Output | Description                |
| ------ | -------------------------- |
| `url`  | The deployed Function URL. |

## Scheduled requests

A `crontab` list in `routes` runs the container on a schedule. Each line is a POSIX crontab
schedule, an optional HTTP method, and a URI the request is sent to inside the container. On AWS
each line becomes an EventBridge Scheduler schedule targeting the function. The request arrives
with `X-Rowdy-Cron` set to the line that triggered it, and rowdy strips that header from every
Function URL request, so an app can treat its presence as proof the request came from its own
schedule. The full grammar, the trust argument, and the deployer permissions are in
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

curl -si -X POST -H 'x-rowdy-cron: forged' https://<your-app>/tunnel/gc   # 401
```

If the endpoint answers `401` with the header exactly as it does without, the header never reached
the app.
