# IAM for the sandbox SDK

> **Proposed.** This is the setup we intend to recommend for `aws.microvm` sandboxes, taken from the
> AWS calls rowdy makes. It hasn't been tested against a real account yet, and part of it needs a
> change to rowdy, noted [below](#what-rowdy-doesnt-do-yet). `aws.lambda` isn't covered.

The SDK acts as whatever AWS credentials it finds, as [sdk.md](../sdk.md#aws-credentials) describes.
To start a microVM sandbox, it creates an IAM role for the VM, gives that role a policy, and passes
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
      "Resource": "arn:aws:iam::123456789012:role/*rowdy.run",
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/RowdySandboxBoundary"
        }
      }
    },
    {
      "Sid": "ReadSandboxRoles",
      "Effect": "Allow",
      "Action": "iam:GetRole",
      "Resource": "arn:aws:iam::123456789012:role/*rowdy.run"
    },
    {
      "Sid": "PassSandboxRolesToLambdaOnly",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::123456789012:role/*rowdy.run",
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
      "Action": ["s3:GetObject", "s3:PutObject"],
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
      "Action": ["logs:CreateLogGroup", "logs:FilterLogEvents", "logs:StartLiveTail"],
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
- **IAM:** the host role can only create, change and pass roles whose names end in `rowdy.run`, which
  is every role rowdy makes, and only with the boundary attached. It can't change the boundary.
- **S3:** one bucket per account, `rowdy-sandboxes-{random}`, found again by its tag, holds each
  sandbox's zip. An S3 ARN names no account, so `aws:ResourceAccount` keeps `rowdy-sandboxes-*` to
  buckets in yours. `s3:PutBucketTagging` and `s3:TagResource` cover a bucket created with tags, whichever
  AWS checks.
- **ECR:** an image is copied into a repository named after it, like `library/alpine`, so the
  repository ARN can't be narrower than the account.
- **CloudWatch Logs:** rowdy makes each sandbox's log group, `/aws/lambda-microvms/{name}`, before it
  builds, so the sandbox's role can only write to that one. The other two are `read_output` and
  `sandbox.output()`, and `logs:StartLiveTail` is only used with a `timeout`.

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
      "Resource": "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda-microvms/*"
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

With all three in place, credentials for the host role that leak can create a role that reads sandbox
zips, writes microVM logs and pulls images in the account, and nothing more.

## The roles rowdy creates

For reference, each microVM sandbox gets a role named `{namespace}+{image}@{name}.rowdy.run`, like
`library+alpine@sandbox-d99dbbd84.rowdy.run`, which the boundary above caps.

- **Trust:** `lambda.amazonaws.com`, with `sts:AssumeRole` and `sts:TagSession`. It builds the image
  and runs the VM.
- **`RowdyPolicy`:** `s3:GetObject` on that sandbox's own zip, writing to that sandbox's own log group,
  and pulling from that sandbox's own ECR repository.

## What rowdy doesn't do yet

- **Attach the boundary.** rowdy creates sandbox roles with no `PermissionsBoundary`, so
  `SandboxRolesOnlyWithTheBoundary` refuses them until it sets one.
- **Roles that exist already.** A sandbox role made before the boundary has none, so updating its policy
  is refused too. Add the boundary to it once with an administrator's credentials, or delete it and let
  rowdy make it again.
- **Checked against AWS.** We haven't confirmed that microVMs check `iam:PassedToService` against
  `lambda.amazonaws.com`, which tagging permission S3 wants for a tagged bucket, or that
  `aws:ResourceAccount` matches on `s3:CreateBucket`, whose bucket doesn't exist yet.
