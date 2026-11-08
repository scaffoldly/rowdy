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
