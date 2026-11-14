# Sandbox

`@scaffoldly/rowdy/sandbox` runs commands in a container on AWS, from your own code. You name an
image, and rowdy does the rest: it copies the image into ECR, adds itself as a layer, creates the
role and what it runs on, and carries each command's output back as it is written. The API follows
`@vercel/sandbox`.

```ts
import { Sandbox } from '@scaffoldly/rowdy/sandbox';

const sandbox = await Sandbox.create();

try {
  const result = await sandbox.runCommand('echo', ['hello world']);

  console.log(result.exitCode); // 0
  console.log(await result.stdout()); // hello world
} finally {
  await sandbox.stop();
}
```

Installing the package and AWS credentials are covered in [the SDK docs](../sdk.md).

## Runtime

`runtime` picks what a sandbox runs on, and the limits of the other options follow from it. TypeScript
checks them against that choice, and `Sandbox.create` throws a `RangeError` for a value out of range
before anything reaches AWS.

|                         | `aws.lambda`                       | `aws.microvm` (default)              |
| ----------------------- | ---------------------------------- | ------------------------------------ |
| Runs on                 | A Lambda function                  | A Lambda MicroVM                     |
| `timeout`, in ms        | 1000 to 900000, whole seconds      | 1000 to 28800000, whole seconds      |
| `timeout` limits        | Each command                       | The VM, from its first command       |
| `memory`, in MB         | 128 to 10240, whole                | 512, 1024, 2048, 4096 or 8192        |
| `env`                   | No limit from rowdy                | At most 50 variables                 |
| Between commands        | Each command is its own invocation | Commands share one VM, and its files |
| `stop()`                | Rejects, for now                   | Ends the VM                          |
| `delete()`              | Removes the function               | Removes the image                    |
| A command's `signal`    | Only the waiting stops             | Kills the command                    |
| Ctrl+C during a command | Node's default                     | Stops the sandbox, then exits        |

A microVM stays up after its command exits, and is billed, until `stop()` or `timeout`. Call `stop()`
in a `finally`, as above. MicroVMs run on x86_64 only.

## `Sandbox.create`

```ts
const sandbox = await Sandbox.create({
  runtime: 'aws.microvm',
  image: 'node:24',
  name: 'builds',
  timeout: 30 * 60 * 1000,
  memory: 2048,
  env: { CI: 'true' },
  logLevel: 'info',
  signal: AbortSignal.timeout(10 * 60 * 1000),
});
```

| Option         | Default              |                                                                                                           |
| -------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `runtime`      | `aws.microvm`        | See [Runtime](#runtime).                                                                                  |
| `image`        | `scaffoldly/sandbox` | The container image. An image with no registry comes from `mirror.gcr.io`.                                |
| `name`         | `sandbox`            | The prefix of the generated name, `{name}-{suffix}`.                                                      |
| `timeout`      | 15 minutes           | See [Runtime](#runtime).                                                                                  |
| `memory`       | 512                  | See [Runtime](#runtime).                                                                                  |
| `env`          |                      | Environment variables for every command.                                                                  |
| `meta`         |                      | Kept with the sandbox, for `list` and `get` to match. See [Meta](#meta).                                  |
| `layersFrom`   |                      | Images whose layer goes into the sandbox's image. See [Layers](#layers).                                  |
| `logLevel`     | `warn`               | See [Logging](../sdk.md#logging).                                                                         |
| `pollInterval` | 5000, 250 to stop    | Milliseconds between checks on a microVM sandbox as it builds, starts or stops. Each is a request to AWS. |
| `credentials`  | the AWS SDK's chain  | What its AWS clients act as. See [AWS credentials](../sdk.md#aws-credentials).                            |
| `signal`       |                      | See [Aborting](#aborting).                                                                                |
| `wait`         | `true`               | Whether `create` waits for the build. See below.                                                          |

A private image is read with the credentials `docker login` saved for its registry.

On `aws.lambda`, `HOME` defaults to `/tmp`, the only writable path, and the `XDG_*` base directories to
their usual places under it. `env` can override them.

The suffix is a hash of `runtime`, `image`, `timeout`, `memory`, `env`, `meta` and `layersFrom`, so the same values under
the same `name` give you the same sandbox. A second `create` doesn't build anything, and on `aws.microvm` it
shares the first one's VM. A different `name` or value gives a sandbox of its own.

`create` resolves when the sandbox is ready for a command, with nothing running yet. On `aws.microvm` the
first build takes about two minutes, and a repeat takes seconds. A new rowdy release counts as a new
image, so the next `create` builds again.

With `wait: false`, an `aws.microvm` sandbox resolves as soon as AWS is building its image, which suits a host
that can't hold a request open for two minutes. `status()` says where the build is: `building`, `ready`, or
`failed` with AWS's `reason`. A command before it's ready rejects. `aws.lambda` always waits.

```ts
const sandbox = await Sandbox.create({ image: 'node:24', wait: false });
while ((await sandbox.status()).state === 'building') await new Promise((r) => setTimeout(r, 10_000));
```

What `create` returns has the sandbox's methods before it resolves. Each waits for the sandbox, then calls it,
and a failed `create` is each call's rejection. Until then, a failed `create` isn't an unhandled rejection.

```ts
const sandbox = Sandbox.create({ image: 'node:24' });
const result = await sandbox.runCommand('node', ['--version']);
await sandbox.stop();
```

## `runCommand`

```ts
const finished = await sandbox.runCommand('npm', ['test']);
```

There is no shell, so pipes and redirects need `sh -c`:

```ts
await sandbox.runCommand('sh', ['-c', 'npm test | tee /tmp/test.log']);
```

The object form adds a working directory, environment variables and live output. A command's `env`
overrides the sandbox's.

```ts
await sandbox.runCommand({
  cmd: 'npm',
  args: ['test'],
  cwd: '/app',
  env: { NODE_ENV: 'test' },
  stdout: process.stdout,
  stderr: process.stderr,
});
```

`runCommand` resolves when the command exits, whatever its exit code, and rejects only if the command
could not run. Check `exitCode` yourself:

```ts
if (finished.exitCode !== 0) {
  throw new Error(await finished.stderr());
}
```

| Result      |                                                                     |
| ----------- | ------------------------------------------------------------------- |
| `cmdId`     | Where the command's output is logged. See [`output`](#output).      |
| `exitCode`  | The exit code.                                                      |
| `stdout()`  | Resolves to what the command wrote to stdout, up to the last 1 MiB. |
| `stderr()`  | Resolves to what the command wrote to stderr, up to the last 1 MiB. |
| `truncated` | Whether either lost its start to that limit.                        |

To keep all of a long output, pass `stdout` and `stderr` streams, which get everything.

## Detached commands

On `aws.microvm`, `detached: true` resolves once the command has started, and the command outlives this process.

```ts
const command = await sandbox.runCommand({
  cmd: 'npm',
  args: ['run', 'build'],
  detached: true,
  stdout: process.stdout,
});

const { exitCode } = await command.wait();
```

Output keeps reaching `stdout` and `stderr` until the command exits. Its `signal` stops following the command, without killing it: only `stop()` or the sandbox's `timeout` ends it. [`output`](#output) reads what it printed from anywhere. On `aws.lambda`, `detached` rejects.

## `output`

Reads part of a command's output back from CloudWatch Logs by its `cmdId`, any time after it started. Use it for what `stdout()` cut, or from a different process with `Sandbox.get`.

A `cmdId` says where in the sandbox's own log the command's output is: the sandbox's name, the day, version and VM
of its log stream, and the command's id, as `rowdy://exec/{sandbox}/{day}/{version}/{vm}/{exec}`, gzipped and
base64url-encoded. It has no account ID or log group ARN in it. `output` refuses one from another sandbox before it
reaches AWS.

```ts
const first = await sandbox.output(cmdId);
const next = await sandbox.output(cmdId, { cursor: first.cursor });
```

| Option    | What it does                                                           |
| --------- | ---------------------------------------------------------------------- |
| `cursor`  | Where an earlier read stopped. Leave it out to start at the beginning. |
| `stream`  | `stdout` or `stderr`. Defaults to both, merged.                        |
| `timeout` | Milliseconds to wait for more once what's written has been read.       |
| `signal`  | Stops the read.                                                        |

Each read answers with at most 64 KiB:

| Field      | What it is                                                                     |
| ---------- | ------------------------------------------------------------------------------ |
| `text`     | The output read, in the order it was written.                                  |
| `cursor`   | Where this read stopped, for the next one.                                     |
| `exitCode` | Undefined until the read reaches the command's exit.                           |
| `dropped`  | Whether the command printed more than its log keeps: 16 MiB. The rest is gone. |

A log is behind a running command, by about 10 seconds on `aws.microvm` and 30 on `aws.lambda`, so an undefined `exitCode` can mean only that the rest hasn't arrived. Reading needs `logs:FilterLogEvents`, and `logs:StartLiveTail` with `timeout`.

## Files

On `aws.microvm`, files go in and out of the sandbox as bytes, with no shell or tools needed in the image.

```ts
await sandbox.writeFiles([
  { path: 'app.js', content: 'console.log("hi")' },
  { path: 'bin/run.sh', content: Buffer.from('#!/bin/sh\nnode app.js\n'), mode: 0o755 },
]);
await sandbox.mkDir('cache');

const config = await sandbox.readFileToBuffer({ path: 'config.json', cwd: '/etc/app' });
```

- **Paths:** a relative one is from where a command starts without a `cwd`, so `app.js` above is the one `node app.js` finds. `readFileToBuffer` takes its own `cwd` too.
- **`writeFiles`:** writes each file in order, replacing what was there, and makes missing directories. A string is written as UTF-8.
- **`readFileToBuffer`:** resolves to `null` when the file isn't there. `offset` and `length` read part of a file, and only that part leaves the VM. From past the end, it's no bytes.
- **`mkDir`:** makes the directory and its parents, and is fine if it's already there.

Each takes a `signal`, and starts the sandbox's VM if it has none, as a command would. On `aws.lambda`, they reject for now.

## `stop`

`stop()` ends everything running in the sandbox, including a command in progress, whose `runCommand`
rejects. That covers anything started through a `Sandbox.get` of it, in any process. It's safe to call
more than once.

The sandbox itself stays. The next command starts a new VM from the image, without the old one's files.

On `aws.lambda`, `stop()` rejects for now.

## `delete`

`delete()` stops the sandbox, then removes it and what rowdy made for it: on `aws.microvm` its image, role,
zip and log group, and on `aws.lambda` its function, role and log group. Its command output goes with the log
group, and `Sandbox.list` no longer finds it. The ECR repository stays, since every sandbox from the same
image shares it. It's safe to call more than once, and a delete that fails partway can be called again.
`Sandbox.delete(lookup)` on a sandbox whose create failed before it had an image or function deletes the
role that create left.

## `Sandbox.get`

`sandboxId` is the sandbox's name, `{name}-{suffix}`, the same as the function's or the image's. It leaves the
account ID in their ARNs out, so it's safe to show. Another process can use it to connect to the same sandbox:
`get` looks the name up on every runtime, in the account and region its credentials are for. The sandbox's `runtime` says
which one it found it on.

```ts
const { sandboxId } = sandbox;

const again = await Sandbox.get({ sandboxId });
await again.runCommand('ls');
```

```
sandbox-bcdf245678
```

`get` rejects with `Not a sandbox` for anything `create` didn't make, and for an ARN or anything else that isn't a
name. When no runtime has the sandbox, it rejects with what a runtime said other than a miss. A denial is said only
when no other runtime said something else, since credentials that may not use a runtime are denied every name on
it. Pass `runtime` to look on one runtime only; `Sandbox.delete` takes it too. Each runtime's answer is logged at
`debug`.

It takes a `signal`, a `logLevel`, a `pollInterval` and `credentials`, and logs at the level described in
[Logging](../sdk.md#logging).

## `Sandbox.list`

Lists the sandboxes in the account and region, on every runtime, to find a lost `sandboxId` or see what's billed.

```ts
const running = (await Sandbox.list({ runtime: 'aws.microvm' })).filter(({ running }) => running);
```

| Option    | What it does                                                |
| --------- | ----------------------------------------------------------- |
| `runtime` | Only sandboxes on this runtime. Defaults to every runtime.  |
| `meta`    | Only sandboxes whose `meta` has every one of these entries. |
| `signal`  | Rejects the listing.                                        |

Each has its `sandboxId`, `name`, `runtime`, `meta` and `state`, as `status()` says it but without a `reason`. A microVM sandbox also says whether it's `running`, and if it is, `startedAt` and `stopsAt`, when its `timeout` ends it. A Lambda sandbox is billed only while a command runs, so it has neither.

## Meta

`meta` is a host's own labels for a sandbox, like who it's for. A sandbox keeps what `create` was given, and
`Sandbox.list` and `Sandbox.get` match on it:

```ts
const sandbox = await Sandbox.create({ meta: { sub: 'github:1' } });

const ours = await Sandbox.list({ meta: { sub: 'github:1' } });
const again = await Sandbox.get({ sandboxId, meta: { sub: 'github:1' } });
```

`get` refuses a sandbox whose `meta` doesn't have every entry given, as it does one that isn't a sandbox.
Different `meta` is a different sandbox, even with the same options. On AWS each entry is a tag,
`run.rowdy.meta.{key}`, so keys and values are what AWS takes in a tag.

## Layers

`layersFrom` adds the layer of other images to the sandbox's image, after rowdy's own, so a tool is there on
any image:

```ts
const sandbox = await Sandbox.create({ image: 'python:3.12-slim', layersFrom: ['ghcr.io/jqlang/jq:latest'] });
```

Each one must be public and set no `Env` but `PATH`. Only its layers go in, not its config, so jq above is at
`/jq`, where its image put it. Its layers go in for each of the sandbox image's platforms it's published for,
and are skipped on the others.

**Use images that add only their own files.** An image built `FROM scratch` with a static binary, like jq's or
rowdy's own, fits any base. An image that ships a whole root filesystem, like `alpine` or anything built from
it, overwrites the sandbox image's `/bin`, libraries and C library, and can leave it unable to run. rowdy
doesn't look at the files a layer adds, so it can't refuse one like that. The layers are part of the
image the sandbox is built from, so a sandbox started again after a `stop` still has them. Different layers
are a different sandbox.

## Aborting

```ts
const controller = new AbortController();

const sandbox = await Sandbox.create({ runtime: 'aws.microvm', signal: controller.signal });

await sandbox.runCommand({ cmd: 'sleep', args: ['60'], signal: AbortSignal.timeout(5000) });
```

| Signal given to                 | What an abort does                                                   |
| ------------------------------- | -------------------------------------------------------------------- |
| `Sandbox.create`, `Sandbox.get` | Rejects work in progress, kills its commands, and stops the sandbox. |
| `runCommand`                    | Kills that command and rejects. The sandbox stays up.                |
| Both                            | Both of the above.                                                   |

A signal that has already aborted rejects straight away. A killed command gets `SIGTERM`, along with
anything it started, then `SIGKILL` two seconds later.

On `aws.lambda`, only the rejecting happens. The command runs on until it exits or hits `timeout`, and
there is nothing to stop.

## Ctrl+C

On a sandbox that can `stop()`, Ctrl+C during a command stops the sandbox and then exits as usual, so
no VM is left running. A second Ctrl+C quits straight away, without waiting. A program with its own
`SIGINT` handler decides how it exits.

This only applies during a command. Between commands, Ctrl+C ends the process and leaves the VM
running until `timeout`, unless the program stops it.

## Events

Rowdy reports what it does. Every event has a readable `message`. Check `source` before anything else, since the rest
depends on it. A step on AWS has `source: 'cdk'` and a
`type`, which narrows its `lifecycle`:

| `type`     | `lifecycle`               |
| ---------- | ------------------------- |
| `describe` | `describing`, `described` |
| `read`     | `reading`, `read`         |
| `create`   | `creating`, `created`     |
| `update`   | `updating`, `updated`     |
| `dispose`  | `disposing`, `disposed`   |
| `tag`      | `tagging`, `tagged`       |

`failed` can follow any of them.

```ts
{
  source: 'cdk',
  message: 'CreateRole: creating',
  type: 'create',
  lifecycle: 'creating',
  client: 'IAMClient',
  action: 'CreateRole',
  name: 'sandbox-abc',
}
```

Copying an image into ECR reports its progress with `source: 'transfer'`, whenever that changes:

```ts
{
  source: 'transfer',
  message: 'Copying the image: 4/9 transfers: 40% complete',
  lifecycle: 'copying',
  summary: '4/9 transfers: 40% complete',
}
```

`lifecycle` is `copying`, `copied` or `failed`.

A request that runs into something says so with `source: 'http'`, and `type` says what. A registry that rate-limits
one is `type: 'rate-limited'`. The request waits as long as its `Retry-After`
says, or its own backoff without one, then tries again. Requests in parallel can be limited at once, so a host that
passes these on may want to debounce them.

```ts
{
  source: 'http',
  message: 'Rate limited by mirror.gcr.io pulling library/alpine, trying again in 30 seconds',
  type: 'rate-limited',
  summary: 'Rate limited by mirror.gcr.io pulling library/alpine, trying again in 30 seconds',
  wait: 30000,
  retryAfter: '30',
}
```

`wait` is the milliseconds until it tries again. `retryAfter` is the registry's own header, and it's missing when the
registry sent none and the wait is rowdy's backoff.

Pass `onEvent` to `Sandbox.create` or `runCommand`. It can be a callback or a promise of one. Callbacks run one at a
time, in order, and an error from one is logged and doesn't affect the sandbox.

```ts
const sandbox = await Sandbox.create({
  runtime: 'aws.microvm',
  onEvent: (event) => {
    if (event.source === 'cdk' && event.type === 'create' && event.lifecycle === 'created') {
      console.error(event.action);
    }
  },
});

await sandbox.runCommand({ cmd: 'npm', args: ['test'], onEvent: (event) => console.error(event) });
```

On `create`, it receives every event for as long as the sandbox is in use. On `runCommand`, it receives what happens
while that command runs. That includes polling, so filter on `type`.

For an Observable, call `.events()`. Nothing is kept, so it starts from when you subscribe: to see the build, call it on
what `create` returns, before you await it.

```ts
const creating = Sandbox.create({ runtime: 'aws.microvm' });
creating.events().subscribe(console.error);
const sandbox = await creating;
```

A command's own output isn't an event.

## Prebuilt images

On `aws.microvm`, `Sandbox.create` first looks for an image prebuilt by
`rowdy create aws microvm --build` from exactly what the sandbox would build (see
[the runtime docs](../runtime.md#prebuilt-microvm-images)). It reads only manifests to work out the
image's name, then reads the image by that name. A match starts in seconds instead of building for about
two minutes, and the create emits a `{ source: 'sandbox', type: 'prebuilt' }` event, "Starting from a
prebuilt image". With no match, it builds as before.

A match needs everything that goes into the image to be the same:

- the image and its platform digest
- every `layersFrom`, and rowdy's own layer, by digest
- `memory`
- `env`
- rowdy's version

The `timeout` and `meta` don't count, since they're set when the VM starts.

A sandbox started from a prebuilt image is its one VM, so it differs from other microVM sandboxes:

- **`sandboxId`** is the VM's id, like `microvm-ee6ef309-…`. `Sandbox.get` and `Sandbox.list` find it
  by that.
- **It starts on `create`**, and is billed from then until `stop()` or `timeout`.
- **`stop()` ends it.** A later command doesn't start a new VM: it rejects, and you create another
  sandbox.
- **Every `create` makes a new sandbox**, even with the same options.
- **It runs with no IAM role**, so code in it has no AWS credentials at all. With no role it writes no
  log, so [`output`](#output) reads a command's output from the VM itself, where rowdy keeps each
  command's lines, up to 16 MiB. That works only while the VM runs: once it ends, `output` rejects
  with "This sandbox has stopped, and its command output went with it." Read what you need first.
- **`delete()`** ends its VM and removes its record from the sandbox bucket. The prebuilt image is never
  deleted.

## What rowdy creates

Each sandbox gets its own resources, in the account and region of your credentials:

- **An ECR repository** named after the image, holding the copy with rowdy added.
- **An IAM role** that Lambda assumes. On `aws.microvm` it builds the image and runs the VM, and can read
  only its own ECR repository and its own zip.
- **A Lambda function** on `aws.lambda`, or **a MicroVM image** on `aws.microvm`.

`aws.microvm` also keeps a zip per sandbox in one S3 bucket per account, `rowdy-sandboxes-{random}`,
found again by its `rowdy:owner` tag.

The credentials you run with need to be able to create all of these. `stop()` only ends what's running, and
`delete()` removes everything but the ECR repository.

## Errors

A rejection keeps its class, so `instanceof RangeError` still works, and its message says what to do next when
there's something to do: `Retrying may help.` for throttling or a fault on AWS's side, or
`Check the AWS credentials and permissions this runs with.` for a denial or an expired token.

A host can cap how many requests one of its own requests sends, as a Cloudflare Worker on the free plan does at 50.
A `create` that hits the cap partway keeps what finished in AWS: the image layers already copied, the role, the
build. The same `create` again goes on from there, so a big image can take a few calls. A larger `pollInterval`
spends fewer requests waiting on the build.

`@scaffoldly/rowdy/sandbox/core` has what a host needs without the AWS clients, about 6 KB gzipped, for a
Cloudflare Worker that only describes sandboxes or their errors:

| Export            |                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `describeError`   | `{ message, remedy }`, with ARNs and account IDs masked. `remedy` is `retry`, `ask`, `none` or unset. |
| `humanize`        | The same error, its message saying what to do next, as `create` and the rest reject with.             |
| `SandboxError`    | What rowdy rejects with when calling again won't help. `describeError` gives it `remedy: none`.       |
| `OUT_OF_REQUESTS` | Matches the error a host's cap on outgoing requests gives.                                            |
| `DEFAULTS`        | `timeout` and `memory` when the options don't set them.                                               |
| `MICROVM_MEMORY`  | The `memory` sizes `aws.microvm` takes.                                                               |

`@scaffoldly/rowdy/sandbox` exports these too.

## Not there yet

- Files on `aws.lambda`.
- `stop()` on `aws.lambda`.
