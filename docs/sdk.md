# SDK

`@scaffoldly/rowdy` can be used as a library from Node, for work the CLI and the GitHub Action don't
cover. It is published under the `beta` tag:

```sh
npm install @scaffoldly/rowdy@beta
```

It needs Node 20 or later.

| Import                      | What it does                                             | Docs                             |
| --------------------------- | -------------------------------------------------------- | -------------------------------- |
| `@scaffoldly/rowdy/sandbox` | Runs commands in a container on AWS, from your own code. | [sdk/sandbox.md](sdk/sandbox.md) |

## AWS credentials

The SDK uses the AWS SDK's usual credential and region chain, so anything that works for the `aws`
CLI works here: `AWS_PROFILE`, `AWS_REGION`, an instance or task role, and so on. It acts as those
credentials, and creates what it needs in that account and region.

For what those credentials need for `aws.microvm`, and a permissions boundary that keeps them from acting
as an administrator, see [sdk/iam.md](sdk/iam.md).

Credentials the process doesn't have yet, like ones from `AssumeRoleWithWebIdentity`, can come from
`Sandbox.withEnv`. It returns a `SandboxFactory` that calls your function before each `create`, `get`
and `list` reaches AWS, and puts what it returns on `process.env`, where the AWS SDK reads it:

```ts
import { STSClient, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';
import { Sandbox } from '@scaffoldly/rowdy/sandbox';

const factory = Sandbox.withEnv(async () => {
  const { Credentials } = await new STSClient({}).send(new AssumeRoleWithWebIdentityCommand({ ... }));
  return {
    AWS_ACCESS_KEY_ID: Credentials?.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: Credentials?.SecretAccessKey,
    AWS_SESSION_TOKEN: Credentials?.SessionToken,
    AWS_CREDENTIAL_EXPIRATION: Credentials?.Expiration?.toISOString(),
  };
});

const sandbox = await factory.create({ image: 'node:24' });
```

The factory works anywhere a `SandboxFactory` does, like the [MCP tools](sdk/sandbox.md#mcp-tools).

- The function runs on every call, so cache in it whatever's costly to get.
- A variable it leaves undefined keeps its value.
- What it sets stays on `process.env` for the rest of the process, so every sandbox in it shares the
  latest values.
- The values never reach a sandbox: not its `env`, and not a command's.

## Logging

Your program's stdout stays yours: everything the SDK logs goes to stderr, at every level.

The level defaults to `warn`, not the `info` of the CLI, so a program's terminal stays quiet unless
something is wrong. The `logLevel` option of `Sandbox.create` sets it, and otherwise the variables in
[Logging](../README.md#logging) do: `ROWDY_LOG_LEVEL`, `ROWDY_DEBUG` and `ROWDY_TRACE`. A variable
wins only when `logLevel` is left out.

```sh
ROWDY_LOG_LEVEL=info node index.js 2>rowdy.log
```

The level and where logs go apply to the whole process, so every sandbox in it shares them.
