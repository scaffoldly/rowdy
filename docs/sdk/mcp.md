# MCP tools

`@scaffoldly/rowdy/mcp` has the tools for a model that manages its own sandboxes, keyed by name. A host adds
`tools.factory` to its own server: `create_sandbox`, `get_sandbox`, `list_sandboxes` and `stop_sandbox`. Each
`run` takes the SDK first, then the input, then the call's context with what the host adds: the `server`, its
`signal`, and optionally `meta`, `layersFrom`, `limits`, `logLevel`, `pollInterval` and `credentials`.

```ts
import { Sandbox } from '@scaffoldly/rowdy/sandbox';
import { tools } from '@scaffoldly/rowdy/mcp';

Object.values(tools.factory).forEach(({ name, run, ...config }) =>
  server.registerTool(name, config, (input, ctx) =>
    run(Sandbox, input, { ...ctx, server, signal, meta: { sub }, limits: { runtimes: ['aws.microvm'] } })
  )
);
```

`meta` goes on every sandbox a call creates, and a call only lists, gets or stops sandboxes with it, so a model
can't reach another's. `layersFrom` goes into every sandbox a call creates, and a model can't change it.
`limits` cap what a model can ask for, and only `limits.runtimes` are listed, so a host that allows only
`aws.microvm` needs no `lambda:ListFunctions`. `pollInterval` is for a host with a cap on its requests, as in
[Errors](sandbox.md#errors). A `create_sandbox` that hits the cap tells the model to make the same call again. Any other
tool only says the host ran out, since a command may already have run.

`credentials`, set per call, are what that call's AWS clients act as, such as the caller's own role from the
token their request came with:

```ts
server.registerTool(name, config, (input, ctx) =>
  run(Sandbox, input, {
    ...ctx,
    server,
    signal,
    credentials: fromWebToken({ roleArn, webIdentityToken: ctx.http!.authInfo!.token, roleSessionName: 'caller' }),
  })
);
```

`fromWebToken` is from `@aws-sdk/credential-providers`. A call that comes without a token should be refused before
it gets here.

Each sandbox `create_sandbox` makes gets tools of its own on that server, `tools.lazy`, named with its suffix,
like `run_command_bcdf245678`, with no `sandbox_id` to give: `run_command` and `read_output`, and on
`aws.microvm` `read_file`, `write_file`, `make_directory` and `stop_sandbox`. `get_sandbox` gives a sandbox
that's already there, like one from `list_sandboxes`, its tools again. Without a `server`, a model can create
a sandbox but not work in it. The `signal` is the host's, for as long as what the call starts may run. The
tools come off that server when the sandbox is stopped there, or the `signal` aborts.

A server that lasts the session announces those changes to its client itself. A host that builds a server per
request passes `changed` too, and rowdy calls it whenever a sandbox's tools go on or come off, so the host can
tell its clients to list tools again:

```ts
run(Sandbox, input, { ...ctx, server, signal, changed: () => handler.notify.toolsChanged() });
```

That server is gone after its request, so the host puts each sandbox's tools back on every new one, with
`registerTools`. It lists every sandbox with the context's `meta`, on its `limits.runtimes`, and registers each
one's tools:

```ts
import { registerTools } from '@scaffoldly/rowdy/mcp';

await registerTools(Sandbox, { ...ctx, server, signal, meta, changed });
```

Each call lists sandboxes on AWS, so a host calls it for the requests that need the tools, a `tools/list` or a
call to one of them.

`read_file` answers 64 KiB at a time, read on with `offset`, and a missing file is `found: false`.
`write_file` takes one file, as utf8 or base64, with an octal `mode` like `"755"`.

A host that owns one sandbox gives a model only that one, with `tools()` on it, or on `Sandbox.create`'s
result before it's ready:

```ts
const creating = Sandbox.create();

for (const { name, run, ...config } of creating.tools()) {
  server.registerTool(name, config, run);
}
```

These are `run_command` and `read_output`, the file tools and `stop_sandbox` on `aws.microvm`, with no
`sandbox_id`.
A call waits for the sandbox, and a failed build is each call's error.
