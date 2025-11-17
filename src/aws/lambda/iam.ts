import { CloudResource } from '@scaffoldly/rowdy-cdk';
import {
  IAMClient,
  GetRoleCommand,
  GetRoleResponse,
  CreateRoleCommand,
  GetRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
  Role,
  DeleteRoleCommand,
  GetRolePolicyCommandOutput,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { Transfer } from '../../api/internal/transfer';

export type TrustRelationship = {
  Version: string;
  Statement: {
    Effect: 'Allow';
    Principal: {
      Service: string;
    };
    Action: 'sts:AssumeRole';
  }[];
};

type PolicyStatement = {
  Sid?: string;
  Effect: 'Allow';
  Action: string[];
  Resource: string[];
  Condition?: {
    StringEquals?: Record<string, string | string[]>;
  };
};

export type PolicyDocument = {
  Version: string;
  Statement: PolicyStatement[];
};

const mergeTrustRelationships = (trustRelationships: (TrustRelationship | undefined)[]): TrustRelationship => {
  return {
    Version: '2012-10-17',
    Statement: trustRelationships
      .flatMap((trustRelationship) => trustRelationship?.Statement)
      .filter((statement) => !!statement),
  };
};

const mergePolicyDocuments = (policyDocuments: (PolicyDocument | undefined)[]): PolicyDocument => {
  return {
    Version: '2012-10-17',
    Statement: policyDocuments
      .flatMap((policyDocument) => policyDocument?.Statement)
      .filter((statement) => !!statement),
  };
};

export interface IamConsumer {
  get trustRelationship(): TrustRelationship | undefined;
  get policyDocument(): PolicyDocument | undefined;
}

export class IamRoleResource extends CloudResource<Role, GetRoleResponse> {
  public readonly client = new IAMClient({});
  private consumers: IamConsumer[] = [];
  private _role?: Partial<Role>;
  private _policy: IamPolicyResource;

  constructor(protected image?: CRI.ImageSpec) {
    super(
      {
        describe: (role) => ({ type: 'IAM Role', label: role.RoleId }),
        read: async () => this.client.send(new GetRoleCommand({ RoleName: this._roleName })),
        create: async () =>
          this.client.send(
            new CreateRoleCommand({
              RoleName: this._roleName,
              AssumeRolePolicyDocument: this.assumeRolePolicyDocument,
            })
          ),
        update: async () =>
          this.client.send(
            new UpdateAssumeRolePolicyCommand({
              RoleName: this._roleName,
              PolicyDocument: this.assumeRolePolicyDocument,
            })
          ),
        dispose: (role) => this.client.send(new DeleteRoleCommand({ RoleName: role.RoleName })),
      },
      (output) => output.Role
    );

    this._policy = new IamPolicyResource(this);
  }

  private get _roleName(): string {
    const { registry, namespace, name } = Transfer.normalizeImage(this.image?.image || '');
    return `${namespace}+${name}@${registry}`;
  }

  public get RoleId(): PromiseLike<string> {
    return this.Resource.then((r) => r.RoleId!);
  }

  public get RoleName(): PromiseLike<string> {
    return this.Resource.then((r) => r.RoleName!);
  }

  public get RoleArn(): PromiseLike<string> {
    return this.Resource.then((r) => r.Arn!);
  }

  public withConsumer(consumer: IamConsumer): this {
    this.consumers.push(consumer);
    return this;
  }

  get assumeRolePolicyDocument() {
    return JSON.stringify(mergeTrustRelationships(this.consumers.map((consumer) => consumer.trustRelationship)));
  }

  get policyDocument() {
    return JSON.stringify(mergePolicyDocuments(this.consumers.map((consumer) => consumer.policyDocument)));
  }
}

class IamPolicyResource extends CloudResource<PolicyDocument, GetRolePolicyCommandOutput> {
  get policyName() {
    return `default`;
  }

  constructor(protected role: IamRoleResource) {
    super(
      {
        describe: () => {
          return { type: 'IAM Role Policy', label: this.policyName };
        },
        read: async () =>
          this.role.client.send(
            new GetRolePolicyCommand({
              RoleName: await role.RoleName,
              PolicyName: this.policyName,
            })
          ),
        create: async () =>
          this.role.client.send(
            new PutRolePolicyCommand({
              RoleName: await role.RoleName,
              PolicyName: this.policyName,
              PolicyDocument: role.policyDocument,
            })
          ),
        update: async () =>
          this.role.client.send(
            new PutRolePolicyCommand({
              RoleName: await role.RoleName,
              PolicyName: this.policyName,
              PolicyDocument: role.policyDocument,
            })
          ),
        dispose: async () =>
          this.role.client.send(
            new DeleteRolePolicyCommand({
              RoleName: await role.RoleName,
              PolicyName: this.policyName,
            })
          ),
      },
      (output) => {
        return JSON.parse(output.PolicyDocument ? decodeURIComponent(output.PolicyDocument) : '{}');
      }
    );
  }
}
