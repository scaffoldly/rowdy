# IAM for the sandbox SDK

> **Proposed.** This is the setup we intend to recommend for `aws.microvm` and `aws.lambda` sandboxes,
> taken from the AWS calls rowdy makes. It hasn't been tested against a real account yet, and part of it
> needs a change to rowdy, noted [below](#what-rowdy-doesnt-do-yet).

The SDK acts as whatever AWS credentials it finds, as [sdk.md](../sdk.md#aws-credentials) describes.
To start a sandbox, it creates an IAM role for the VM or function, gives that role a policy, and passes
it to Lambda. Credentials that can do all three for any role and any policy can make themselves an
administrator, so this setup has three parts:

1. **A host role** your code runs as, with only what the SDK calls.
2. **A trust relationship** saying who may use that role.
3. **A permissions boundary** that caps every role the host role creates, whatever policy it's given.
   It goes on those roles, not on the host role.

Replace `123456789012` with your account ID and `us-east-1` with your region throughout.

## The host role

Name it `RowdySandboxHost`, or anything else: only the sandbox roles' names matter, below.

### Trust relationship

Who may assume the host role. This example trusts one IAM user in the same account. Use whatever
principal your code runs as: a user whose keys are in your Worker's environment, an OIDC provider,
another role, or a service.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::123456789012:user/sandbox-host" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### Permissions

Everything the SDK calls for `aws.microvm`, by what it's for.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "MicroVMs",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateMicrovmImage",
        "lambda:UpdateMicrovmImage",
        "lambda:GetMicrovmImage",
        "lambda:GetMicrovmImageVersion",
        "lambda:ListMicrovmImages",
        "lambda:ListManagedMicrovmImages",
        "lambda:ListManagedMicrovmImageVersions",
        "lambda:RunMicrovm",
        "lambda:GetMicrovm",
        "lambda:ListMicrovms",
        "lambda:TerminateMicrovm",
        "lambda:DeleteMicrovmImage",
        "lambda:CreateMicrovmAuthToken",
        "lambda:ListTags",
        "lambda:TagResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AwsNetworkConnectors",
      "Effect": "Allow",
      "Action": "lambda:PassNetworkConnector",
      "Resource": "arn:aws:lambda:*:aws:network-connector:aws-network-connector:*"
    },
    {
      "Sid": "SandboxRolesOnlyWithTheBoundary",
      "Effect": "Allow",
      "Action": ["iam:CreateRole", "iam:PutRolePolicy", "iam:UpdateAssumeRolePolicy"],
      "Resource": "arn:aws:iam::123456789012:role/rowdy/sandbox/*",
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/RowdySandboxBoundary"
        }
      }
    },
    {
      "Sid": "ReadAndDeleteSandboxRoles",
      "Effect": "Allow",
      "Action": ["iam:GetRole", "iam:DeleteRolePolicy", "iam:DeleteRole"],
      "Resource": "arn:aws:iam::123456789012:role/rowdy/sandbox/*"
    },
    {
      "Sid": "FindSandboxRoles",
      "Effect": "Allow",
      "Action": "iam:ListRoles",
      "Resource": "*"
    },
    {
      "Sid": "PassSandboxRolesToLambdaOnly",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::123456789012:role/rowdy/sandbox/*",
      "Condition": { "StringEquals": { "iam:PassedToService": "lambda.amazonaws.com" } }
    },
    {
      "Sid": "KeepTheBoundary",
      "Effect": "Deny",
      "Action": [
        "iam:DeleteRolePermissionsBoundary",
        "iam:PutRolePermissionsBoundary",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion"
      ],
      "Resource": "*"
    },
    {
      "Sid": "WhoAmI",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "FindTheSandboxBucket",
      "Effect": "Allow",
      "Action": "s3:ListAllMyBuckets",
      "Resource": "*"
    },
    {
      "Sid": "TheSandboxBucket",
      "Effect": "Allow",
      "Action": ["s3:CreateBucket", "s3:ListBucket", "s3:GetBucketTagging", "s3:PutBucketTagging", "s3:TagResource"],
      "Resource": "arn:aws:s3:::rowdy-sandboxes-*",
      "Condition": { "StringEquals": { "aws:ResourceAccount": "123456789012" } }
    },
    {
      "Sid": "SandboxZips",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::rowdy-sandboxes-*/*",
      "Condition": { "StringEquals": { "aws:ResourceAccount": "123456789012" } }
    },
    {
      "Sid": "EcrToken",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "CopyImagesIn",
      "Effect": "Allow",
      "Action": [
        "ecr:DescribeRepositories",
        "ecr:CreateRepository",
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
      ],
      "Resource": "arn:aws:ecr:us-east-1:123456789012:repository/*"
    },
    {
      "Sid": "SandboxLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:FilterLogEvents", "logs:StartLiveTail"],
      "Resource": "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda-microvms/*"
    }
  ]
}
```

- **MicroVMs:** these sit under Lambda's `lambda:` prefix. `Resource` is `*` until the ARN forms each
  action takes are confirmed. `lambda:TagResource` is there because images are created with tags.
- **Network connectors:** each VM starts with two connectors AWS owns, `HTTP_INGRESS` for the endpoint
  rowdy calls and `INTERNET_EGRESS` for its internet access, like
  `arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:HTTP_INGRESS`. Passing them
  takes `lambda:PassNetworkConnector`. They're owned by AWS, not your account, so the ARN keeps `*` for
  the region. rowdy uses no VPC connector of your own, so nothing under `ec2:`
  is needed.
- **IAM:** the host role can only create, change, pass and delete roles under the path `/rowdy/sandbox/`,
  where rowdy puts every sandbox's role, and only create them with the boundary attached. It can't change
  the boundary. The roles of apps rowdy deploys sit at the root path, `/`, so it can't touch them, whatever
  they're named. `iam:DeleteRolePolicy` and `iam:DeleteRole` are for `delete()`.
  `iam:ListRoles`, which can't be scoped to a path, finds the role a create left when it failed before
  the sandbox had an image.
- **S3:** one bucket per account, `rowdy-sandboxes-{random}`, found again by its tag, holds each
  sandbox's zip. An S3 ARN names no account, so `aws:ResourceAccount` keeps `rowdy-sandboxes-*` to
  buckets in yours. `s3:PutBucketTagging` and `s3:TagResource` cover a bucket created with tags, whichever
  AWS checks.
- **ECR:** an image is copied into a repository named after it, like `library/alpine`, so the
  repository ARN can't be narrower than the account.
- **CloudWatch Logs:** rowdy makes each sandbox's log group, `/aws/lambda-microvms/{name}`, before it
  builds, so the sandbox's role can only write to that one, and deletes it with the sandbox. The rest are
  for `sandbox.output()`, and `logs:StartLiveTail` is only used with a `timeout`.
- **Prebuilt images:** a sandbox started from a prebuilt image needs nothing more.
  - Reading and running the image use the `MicroVMs` statement.
  - Its own role and log group use the role and `SandboxLogs` statements.
  - Its record, `sandboxes/{microvmId}.json` in the sandbox bucket, uses `SandboxZips`.
  - `Sandbox.list` reads the records with `s3:ListBucket`. Without a sandbox bucket, it finds none and makes none.

### Permissions for `aws.lambda`

An `aws.lambda` sandbox is a Lambda function that runs from a container image, invoked at `$LATEST` for
each command. It has no function URL, alias, published version, resource policy or schedule, and it
doesn't use the sandbox bucket. Add these statements to the host role above for `aws.lambda`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SandboxFunctions",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:UpdateFunctionConfiguration",
        "lambda:UpdateFunctionCode",
        "lambda:InvokeFunction",
        "lambda:ListTags",
        "lambda:TagResource",
        "lambda:DeleteFunction"
      ],
      "Resource": "arn:aws:lambda:us-east-1:123456789012:function:sandbox-*"
    },
    {
      "Sid": "FindSandboxFunctions",
      "Effect": "Allow",
      "Action": "lambda:ListFunctions",
      "Resource": "*"
    },
    {
      "Sid": "ChangeSandboxRoles",
      "Effect": "Allow",
      "Action": ["iam:UpdateRole", "iam:TagRole", "iam:GetRolePolicy"],
      "Resource": "arn:aws:iam::123456789012:role/rowdy/sandbox/*"
    },
    {
      "Sid": "LetLambdaPullImages",
      "Effect": "Allow",
      "Action": ["ecr:GetRepositoryPolicy", "ecr:SetRepositoryPolicy"],
      "Resource": "arn:aws:ecr:us-east-1:123456789012:repository/*"
    },
    {
      "Sid": "SandboxFunctionLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:FilterLogEvents", "logs:StartLiveTail"],
      "Resource": "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/sandbox-*"
    }
  ]
}
```

These statements in the microVM policy cover `aws.lambda` too: `SandboxRolesOnlyWithTheBoundary`,
`ReadAndDeleteSandboxRoles`, `FindSandboxRoles`, `PassSandboxRolesToLambdaOnly`, `KeepTheBoundary`,
`WhoAmI`, `EcrToken` and `CopyImagesIn`. A host that runs only `aws.lambda` keeps those and drops
`MicroVMs`, `AwsNetworkConnectors`, `FindTheSandboxBucket`, `TheSandboxBucket`, `SandboxZips` and
`SandboxLogs`.

- **Functions:** a sandbox's function is named `{name}-{suffix}`, where `name` is the `name` option of
  `Sandbox.create`, `sandbox` by default. The ARNs above assume that default. A host that passes its own
  `name` should use its own prefix, like `function:builds-*`. With `function:*`, the host role can change,
  invoke and delete every function in the account, the apps rowdy deploys included. `create` sends
  `GetFunction` first, and `CreateFunction` only when the function isn't there yet. Each command is an
  `InvokeWithResponseStream`, which IAM checks as `lambda:InvokeFunction`. `get` and `list` read a function's
  tags with `lambda:ListTags`, and `lambda:ListFunctions`, which can't be scoped, finds the sandboxes.
- **IAM:** `create` makes the role first, then sets its description with `iam:UpdateRole`, its trust with
  `iam:UpdateAssumeRolePolicy` and its tags with `iam:TagRole`. `get` reads `RowdyPolicy` with
  `iam:GetRolePolicy`. `CreateFunction` passes the role to `lambda.amazonaws.com`, which is what
  `PassSandboxRolesToLambdaOnly` allows.
- **ECR:** Lambda pulls the function's image from the repository rowdy copies it into, as the microVM
  statements describe. When that repository's policy doesn't let `lambda.amazonaws.com` pull, Lambda adds a
  statement that does, and that takes `ecr:GetRepositoryPolicy` and `ecr:SetRepositoryPolicy` on the
  credentials calling `CreateFunction`. `CopyImagesIn` already has the `ecr:BatchGetImage` and
  `ecr:GetDownloadUrlForLayer` that AWS also asks of them.
- **CloudWatch Logs:** rowdy makes the function's log group, `/aws/lambda/{name}-{suffix}`, before the
  function first runs, and deletes it with the sandbox. `sandbox.output()` reads it with
  `logs:FilterLogEvents`, and with `logs:StartLiveTail` when it's given a `timeout`.

## The permissions boundary

A managed policy named `RowdySandboxBoundary`. It doesn't go on the host role: the host role puts it on
every role it creates, and `SandboxRolesOnlyWithTheBoundary` refuses one without it. AWS lets a role
with a boundary do only what both its own policies and the boundary allow, so a sandbox role can never
do more than this, even with a policy that grants everything. It matches what rowdy gives each
sandbox's role today.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadSandboxZip",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::rowdy-sandboxes-*/*",
      "Condition": { "StringEquals": { "aws:ResourceAccount": "123456789012" } }
    },
    {
      "Sid": "WriteSandboxLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": [
        "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda-microvms/*",
        "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/sandbox-*"
      ]
    },
    {
      "Sid": "EcrToken",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "PullImages",
      "Effect": "Allow",
      "Action": ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
      "Resource": "arn:aws:ecr:us-east-1:123456789012:repository/*"
    }
  ]
}
```

An `aws.lambda` sandbox's `RowdyPolicy` also grants the X-Ray and EC2 network interface actions every
Lambda function's role gets. The boundary leaves them out, since a sandbox has no VPC and no tracing.

With all three in place, credentials for the host role that leak can create a role that reads sandbox
zips, writes sandbox logs and pulls images in the account, and nothing more.

## The roles rowdy creates

For reference, each sandbox gets a role under `/rowdy/sandbox/` named `{namespace}+{image}@{name}.rowdy.run`,
like `arn:aws:iam::123456789012:role/rowdy/sandbox/library+alpine@sandbox-d99dbbd84.rowdy.run`, which the
boundary above caps.

- **Trust:** `lambda.amazonaws.com`, with `sts:AssumeRole` and `sts:TagSession`. It builds the image
  and runs the VM. An `aws.lambda` sandbox's role trusts `lambda.amazonaws.com` with `sts:AssumeRole`,
  to run the function.
- **`RowdyPolicy`:** `s3:GetObject` on that sandbox's own zip, writing to that sandbox's own log group,
  and pulling from that sandbox's own ECR repository. On `aws.lambda`, writing to the function's own log
  group, and the X-Ray and EC2 network interface actions the boundary leaves out.

A sandbox started from a prebuilt image gets a role of its own too, named
`{namespace}+{image}@{name}.{random}.rowdy.run`, since every create makes a new sandbox. It runs the
VM, and code in the VM can read its credentials, so its `RowdyPolicy` lets it write only to its own log
group, `/aws/lambda-microvms/{name}.{random}`. It can also read the prebuilt image's zip and ECR
repository.

## What rowdy doesn't do yet

- **Attach the boundary.** rowdy creates sandbox roles with no `PermissionsBoundary`, so
  `SandboxRolesOnlyWithTheBoundary` refuses them until it sets one.
- **Roles that exist already.** A sandbox role made before the boundary has none, so updating its policy
  is refused too. One made before sandbox roles had their path sits at `/`, out of the host role's reach,
  and a role's path can't change. Delete either once with an administrator's credentials, or `delete()` the
  sandbox with them, and let rowdy make the role again.
- **A boundary on `aws.lambda` roles.** The boundary is only checked on paper against the function's
  `RowdyPolicy`. We haven't run an `aws.lambda` sandbox under it.
- **Checked against AWS.** We haven't confirmed that microVMs check `iam:PassedToService` against
  `lambda.amazonaws.com`, which tagging permission S3 wants for a tagged bucket, or that
  `aws:ResourceAccount` matches on `s3:CreateBucket`, whose bucket doesn't exist yet.
