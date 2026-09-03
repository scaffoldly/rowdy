# Rowdy as a Kubernetes RuntimeClass

Date: 2026-09-03
Status: Draft, awaiting review

## Goal

Make Kubernetes the control plane for Rowdy Lambda functions. A user writes an
ordinary Deployment with `runtimeClassName: rowdy`, and a Lambda function
appears. A Service of `type: LoadBalancer` with
`loadBalancerClass: rowdy.run/function-url` mints a Function URL and reports it
in the Service status. Rollouts, rollbacks, and deletes flow through the normal
Kubernetes objects.

Traffic does not flow through the cluster. Callers hit the Function URL
directly. The pod that Kubernetes runs is a placeholder that owns the Lambda
lifecycle for its ReplicaSet.

## Non-goals for this iteration

- In-cluster traffic path (Service IP → pod → Lambda). Seam kept, not built.
- A containerd shim v2 binary. The runc-wrapper approach below is a drop-in
  seam for one later.
- A mutating admission webhook for node-less clusters (EKS Fargate, GKE
  Autopilot). Same holder binary would serve it; not built now.
- Reserved or provisioned concurrency. `replicas` is recorded as a tag and
  otherwise ignored, reserving that field for concurrency later.
- CloudWatch log tailing into `kubectl logs`.
- Removal of the existing partial CRI implementation
  (`src/aws/lambda/{cri,image,runtime}.ts`, `@scaffoldly/rowdy-grpc`). It stays
  untouched; `LambdaFunction` and `LambdaImageService` are reused.

## Decisions and why

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Traffic model | Cluster is control plane only; callers use Function URL | In-cluster proxy pod | Simplest thing that delivers "Lambdas from k8s primitives". Proxy is additive later. |
| Node access | Real nodes now, node-less later | Webhook-only from day one | The user wants to learn RuntimeClass mechanics. Holder logic is shared, so the webhook is a small follow-up. |
| Object mapping | Deployment = Function, ReplicaSet = Version, Service = Alias + URL | Pod = Function | Gives native rollout/rollback and stable URLs across restarts. |
| Who calls AWS | Holder publishes versions with the pod's ServiceAccount identity; controller manages alias, URL, GC with its own identity | Controller does everything; holder does everything | Per-namespace blast radius through IRSA. Coordination of alias flips and GC stays in one reconciler. |
| Node injection | runc-CLI wrapper under the stock `containerd-shim-runc-v2` | Shim v2 in Go; shim v2 in Node | Zero ttrpc, zero protocol drift, ~10 lines of shell plus a pure TS rewrite. Same pattern as nvidia-container-runtime. |
| Controller language | TypeScript inside rowdy | Go with controller-runtime in a new repo | Small surface (alias, URL, tags, GC). One binary, one image, one release train. |

## Architecture

```
                      kubectl apply Deployment(runtimeClassName: rowdy)
                                        │
   ┌────────────────────────────────────┼─────────────────────────────────┐
   │ node (installer DaemonSet ran here)│                                 │
   │                                    ▼                                 │
   │  kubelet ─► containerd ─► runc shim ─► rowdy-runc create             │
   │                                           │  (1) rowdy oci rewrite   │
   │                                           ▼   config.json           │
   │                                       real runc                      │
   │                                           │                          │
   │                                     pod container                    │
   │                                     process = rowdy hold  ──────────┼──► (2) ECR push, Lambda
   │                                     (pod SA creds / IRSA)            │      function + version
   └──────────────────────────────────────────────────────────────────────┘      + alias rs-<hash>

   rowdy controller (Deployment, own IRSA)  ──watch Service/Pod/RS──► (3) alias svc-<name>
        │                                                                   Function URL
        └─► Service.status.loadBalancer.ingress[0].hostname = xxx.lambda-url.region.on.aws
        └─► (4) GC: versions/functions with no live RS/Deployment
```

### Components

1. **`rowdy-runc`** (node, shell). A runc-CLI-compatible wrapper. On `create`
   it calls `rowdy oci rewrite <bundle>` and then `exec runc "$@"`. Every
   other subcommand passes straight through. Registered in containerd as
   handler `rowdy` with `runtime_type = io.containerd.runc.v2` and
   `BinaryName = /opt/rowdy/bin/rowdy-runc`.
2. **`rowdy oci rewrite`** (node, TypeScript). A pure function over the OCI
   bundle's `config.json`. Sandbox containers pass through. App containers get
   their process replaced with `rowdy hold`, the host rowdy binary bind-mounted
   in, and the original process details stashed in environment variables.
3. **`rowdy hold`** (pod, TypeScript). Derives the function identity from OCI
   annotations, ensures the function, published version, and `rs-<hash>` alias
   exist using the existing `LambdaFunction` builder, writes a ready marker,
   and sleeps until SIGTERM. It never deletes anything.
4. **`rowdy controller`** (cluster, TypeScript). Reconciles Services with
   `loadBalancerClass: rowdy.run/function-url` into an `svc-<name>` alias plus
   Function URL, and runs a periodic GC of versions and functions that no
   longer have a live ReplicaSet or workload.

### Identity

- Holder uses the pod's ServiceAccount through IRSA or EKS Pod Identity. The
  IAM permissions are the same ones `rowdy create lambda` needs today: Lambda
  create/update/publish/alias, IAM role create/put-policy/pass-role, ECR push,
  STS get-caller-identity.
- Controller uses its own ServiceAccount and needs Lambda get/list/alias/URL/
  permission/delete plus IAM delete-role and ECR delete for GC.
- Nodes hold no AWS credentials.
- Every function is tagged `rowdy.run/cluster=<kube-system namespace UID>` so
  several clusters can share an account and GC never crosses clusters.

## Naming

### Inputs

All inputs come from the OCI `config.json`. Nothing on the node talks to the
API server.

| Source | Gives |
|---|---|
| `io.kubernetes.cri.container-type` | `sandbox` → passthrough, `container` → rewrite |
| `io.kubernetes.cri.sandbox-namespace` | namespace |
| `io.kubernetes.cri.sandbox-name` | pod name |
| `io.kubernetes.cri.container-name` | container name |
| `io.kubernetes.cri.image-name` | image reference as the user wrote it |
| `rowdy.run/*` | user pod annotations, forwarded by containerd's `pod_annotations` allowlist |

### Rules

Holder and controller compute these independently and must agree.

- `workload` = pod name minus the trailing `-<pod-template-hash>-<rand5>`.
  StatefulSet pods: minus one trailing segment. Bare Pods: the full name.
  Override with `rowdy.run/workload`.
- `hash` = the pod-template-hash segment. Bare Pods: `latest`.
- **Function name** = `<namespace>-<workload>`. Append `-<container>` only when
  the container name differs from the workload name. Override with
  `rowdy.run/function`. Names over 64 characters are truncated and suffixed
  with a short hash of the full name.
- **Version alias** = `rs-<hash>`.
- **Service alias** = `svc-<service>`.

Examples: Deployment `api` in namespace `prod` with container `api` →
`prod-api`. Same Deployment with container `web` → `prod-api-web`.

### Lambda tags

Function-level tags: `rowdy.run/cluster`, `rowdy.run/namespace`,
`rowdy.run/workload`, `rowdy.run/container` (set by the holder) and
`rowdy.run/replicas` (set by the controller from the ReplicaSet, since the
holder cannot see it). Alias
descriptions carry `<namespace>/<replicaset-name>` for version aliases and
`<namespace>/<service>` for service aliases. GC keys off these only.

## Resource mapping

| Pod spec | Lambda |
|---|---|
| `resources.limits.memory` | MemorySize in MiB. Override `rowdy.run/memory`. The holder itself needs about 96Mi, so document 128Mi as the minimum. |
| `resources.limits.ephemeral-storage` | EphemeralStorage |
| `nodeSelector` `kubernetes.io/arch` | Architectures. Default is the node's arch. |
| `rowdy.run/timeout` | Timeout in seconds. Default 30. |
| `process.args` | Command. Rowdy stays the EntryPoint, as it does today. |
| `process.cwd` | WorkingDirectory |
| `process.env` | Environment, filtered as below |
| `replicas` | Tag `rowdy.run/replicas` only. Placeholder for reserved concurrency. |

### Environment filter

Dropped before reaching Lambda:

- `KUBERNETES_*`, `*_SERVICE_HOST`, `*_SERVICE_PORT*`, `*_PORT_*` (kubelet
  service-link injection)
- Reserved `AWS_*` keys such as `AWS_REGION`, `AWS_ROLE_ARN`,
  `AWS_WEB_IDENTITY_TOKEN_FILE`. Lambda rejects them.
- `ROWDY_HOLD_*`

Everything else passes through: image env, pod env, and `envFrom` secrets,
which the kubelet has already resolved into `process.env`.

## Holder flow (`rowdy hold`)

1. Parse OCI annotations and environment into
   `{ns, workload, hash, function, image, args, env, memory, arch, timeout}`.
2. `GetAlias(function, rs-<hash>)`. If it exists, jump to step 5. This covers
   `replicas > 1`, restarts, and rescheduling. The holder is idempotent.
3. Use the `LambdaFunction` builder: ensure the role, pull the image, inject
   rowdy layers, push to ECR (`transfer.ts`), create or update function config
   and code, and `PublishVersion` → N.
4. `CreateAlias rs-<hash> → N`. On `ResourceConflictException` (a sibling pod
   won the race) fall back to `GetAlias` and continue. Any orphan version from
   the race is collected by GC later.
5. Touch `/tmp/rowdy/ready`. Log the function ARN and version.
6. Sleep. Heartbeat log every 5 minutes. On SIGTERM exit 0.

The holder never deletes anything. Teardown belongs to the controller because
a sibling pod of the same ReplicaSet may still be alive.

Readiness: `rowdy hold --ready` returns 0 when the ready marker exists and is
meant for an opt-in exec readiness probe. Without a probe the pod goes Ready
immediately and the rollout completes before the Lambda exists. The controller
tolerates this because it waits on the alias, not on pod readiness.

Failure: an error in steps 3 or 4 logs and exits 1. The kubelet restarts the
holder with backoff, so the pod shows CrashLoopBackOff with the reason in its
logs. No partial-state cleanup is required; the next attempt converges.

Missing credentials fail fast in step 1 with a clear message.

## Controller: Service → Function URL

Trigger: a Service with `type: LoadBalancer` and
`loadBalancerClass: rowdy.run/function-url`. Other Services are ignored, so
the controller coexists with the AWS Load Balancer Controller.

1. Add the finalizer `rowdy.run/function-url`.
2. Resolve the selector to pods and group them by `(function, hash)` using the
   naming rules. If several hashes are present mid-rollout, choose the hash
   with the most Ready pods; break ties toward the newest ReplicaSet.
3. `GetAlias rs-<hash>`. If missing, the holder is not done: requeue in 5
   seconds and emit the Event `WaitingForFunction`.
4. Upsert the alias `svc-<service>` to point at the same version.
5. Upsert the Function URL on `svc-<service>`. `AuthType` comes from
   `rowdy.run/auth-type` (`NONE` by default, or `AWS_IAM`). `InvokeMode` is
   `RESPONSE_STREAM` because rowdy streams. For `NONE`, add the public invoke
   permission on the alias.
6. Patch `status.loadBalancer.ingress[0].hostname` with the URL host and emit
   the Event `FunctionUrlReady`.
7. On Service delete: remove the URL, the permission, and the alias, then
   remove the finalizer.

Rollout: a new ReplicaSet leads holders to publish `rs-<new>`; once its pods
outnumber the old ones step 2 picks the new hash and the alias flips while
the URL stays the same. Rollback follows the same path in reverse.

Ports: a Function URL is HTTPS on 443 only. `spec.ports` is ignored, with a
warning Event when it is not 443 or 80.

Dependencies: `@kubernetes/client-node` informers on Service, Pod, and
ReplicaSet, leader election through a Lease so `replicas > 1` is safe, and
the controller's own ServiceAccount with IRSA.

## Controller: GC

Runs every 60 seconds and on ReplicaSet, Deployment, and Pod delete events.

1. `ListFunctions`, filtered to the tag `rowdy.run/cluster=<this cluster>`.
   Untagged or other-cluster functions are never touched.
2. For each function, derive `(ns, workload, container)` from tags and list
   its aliases.
3. An `rs-<hash>` alias with no live ReplicaSet of that hash in that namespace
   → `DeleteAlias` and `DeleteFunction(Qualifier=version)`. Skip while an
   `svc-*` alias still points at that version.
4. A function with zero `rs-*` aliases and no live workload in its namespace
   → delete the function, its role, and its ECR image tags.
5. Orphan versions with no alias (holder races) → delete.

"Live" means present in the informer cache. If the cache is not synced, GC
skips that cycle.

## Node side

### `rowdy oci rewrite <bundle>`

A pure function plus one atomic file write, unit-tested against real
containerd `config.json` fixtures.

- Read `config.json`. If `container-type == sandbox` or the pod carries
  `rowdy.run/passthrough: "true"`, do nothing.
- Otherwise:
  - `process.args` → `["/rowdy/bin/rowdy", "hold"]`
  - `process.env` gains `ROWDY_HOLD_ARGS` (JSON of the original args),
    `ROWDY_HOLD_CWD`, `ROWDY_HOLD_MEMORY` (from
    `linux.resources.memory.limit`), and `ROWDY_HOLD_ANNOTATIONS` (JSON of the
    spec annotations, since they are not visible from inside the container).
  - `mounts` gains
    `{destination: /rowdy/bin/rowdy, source: /opt/rowdy/bin/rowdy, type: bind, options: [ro, bind, nosuid, nodev]}`.
  - Annotations are left untouched.
- Write back through a temp file and rename.

### `rowdy-runc`

About ten lines of shell. Intercept `create`, find `--bundle`, run the
rewrite, then `exec runc "$@"`. A rewrite failure exits non-zero, and
containerd surfaces it as `CreateContainerError` with the wrapper's stderr.
The runc path comes from `$ROWDY_RUNC`, falling back to `runc` on PATH.

### containerd config

Delivered as a drop-in file:

```toml
# containerd 2.x
[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.rowdy]
  runtime_type = "io.containerd.runc.v2"
  pod_annotations = ["rowdy.run/*"]
  [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.rowdy.options]
    BinaryName = "/opt/rowdy/bin/rowdy-runc"
    SystemdCgroup = true   # copied from the node's default runc handler
```

containerd 1.7 uses the same block under `plugins."io.containerd.grpc.v1.cri"`.
The installer picks the path from `containerd --version`. The drop-in goes
into the existing `imports` directory when the config declares one
(`/etc/containerd/conf.d` on kind, `/etc/containerd/config.d` on EKS AL2023),
otherwise it is appended to `config.toml` between marker comments,
idempotently.

### Installer DaemonSet

`rowdy-runtime` in namespace `rowdy-system`.

- Image `ghcr.io/scaffoldly/rowdy`, multi-arch, containing the rowdy binary,
  `rowdy-runc`, and `install.sh`.
- Privileged, `hostPID`, hostPath `/` mounted at `/host`.
- `install.sh` copies binaries to `/host/opt/rowdy/bin`, writes the config,
  runs `nsenter -t 1 -m -u -i -n -- systemctl restart containerd`, then
  `sleep infinity` so the pod stays for status and re-runs after a node
  upgrade.
- Labels the node `rowdy.run/runtime=true` through the API (its
  ServiceAccount can `patch nodes`). The RuntimeClass `scheduling.nodeSelector`
  uses that label.
- Uninstall (`kubectl add --remove`) deletes the DaemonSet. The drop-in config
  is left in place; an unused handler is harmless.

### Manifests

`rowdy/k8s/base/` holds `namespace`, `runtimeclass`, `installer` (DaemonSet
plus RBAC), and `controller` (Deployment, RBAC, and a ServiceAccount with an
IRSA annotation placeholder) as a Kustomize base.
`kubectl add github.com/scaffoldly/rowdy/k8s` installs everything.

## Repo layout

```
src/
  k8s/
    oci.ts          rewrite(config) → config, pure
    naming.ts       derive(annotations, overrides) → {ns, workload, hash, function, ...}
    env.ts          filter(env) → env
    hold.ts         rowdy hold / --ready
    controller/
      index.ts      informers, leader election, workqueue
      service.ts    Service reconcile
      gc.ts         GC loop
      lambda.ts     alias / url / permission ops, thin over LambdaFunction
k8s/
  base/             namespace, runtimeclass, installer, controller, kustomization
  scripts/
    rowdy-runc
    install.sh
tests/k8s/
  oci.test.ts       fixtures: real containerd config.json for sandbox and container
  naming.test.ts    table: deployment / statefulset / bare pod / overrides / 64-char
  env.test.ts
  service.test.ts   fake informer cache plus mocked Lambda client
  gc.test.ts
```

`environment.ts` gains the `hold`, `oci rewrite`, and `controller` yargs
commands. The Dockerfile copies `k8s/scripts/*` into the final image. CI must
build multi-arch, since `pkg` currently targets only `linuxstatic` x64 and
Graviton nodes need arm64.

## Testing

1. **Unit** (jest, existing setup). Rewrite, naming, env filter, and reconcile
   logic against a mocked Lambda client and fake informer caches. No AWS, no
   cluster.
2. **Node smoke** (script, no AWS). A kind cluster with
   `containerdConfigPatches` and a hostPath mount of the binary. Apply a pod
   with `runtimeClassName: rowdy` and dummy AWS credentials. Assert that the
   container's process is `rowdy hold` and that the holder fails at the
   credential check with a clear message. This proves the wrapper, the
   rewrite, and the config path end to end.
3. **E2E** (manual or `workflow_dispatch`, real AWS). kind plus the installer
   DaemonSet and the controller with a static-credentials Secret. Apply a
   Deployment and a Service. Assert that the Function URL lands in the Service
   status, `curl` returns 200, a rollout flips the alias, and a delete leaves
   the account empty. Cleanup on failure is a tag sweep.

## Known limitations in this iteration

- **Init containers** are rewritten too, hold forever, and wedge the pod. The
  escape hatch is `rowdy.run/passthrough: "true"`, which skips the rewrite for
  the whole pod. The proper fix is the webhook.
- **Private images.** The holder pulls from the registry itself, not from the
  node's image cache. Use `rowdy.run/image-auth` (the existing
  `Annotations.Images.ImageAuth`) or public images.
- **The node's image pull is wasted.** The kubelet still pulls the image to
  the node. This is a cost, not a correctness problem.
- **`kubectl exec` and `kubectl logs`** show the holder, not the Lambda.
- **Bare Pods** map to `hash=latest` and a single `rs-latest` alias. Use a
  Deployment.

## Future seams

- **Shim v2.** `containerd-shim-rowdy-v1` in Go, importing containerd's
  `pkg/shim` and its runc task service, overriding `Create` to call the same
  rewrite. Later it could skip runc entirely.
- **Webhook.** A mutating admission webhook that keys on
  `runtimeClassName: rowdy`, rewrites the pod to run the holder image, and
  fixes init containers properly. Same holder, no node access.
- **Concurrency.** `replicas` → `ReservedConcurrentExecutions`, and later an
  HPA-driven provisioned concurrency on the service alias.
- **In-cluster traffic.** The holder grows a proxy mode listening on the
  container port inside the pod's network namespace, forwarding to the
  Function URL, so Services and Ingress work unchanged.
