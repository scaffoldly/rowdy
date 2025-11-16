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
import { lastValueFrom, map, of } from 'rxjs';
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

  private get _roleName(): Promise<string> {
    return lastValueFrom(
      of(this.req.imageRef).pipe(
        Transfer.normalize(),
        map(({ registry, name, namespace }) => {
          return `${namespace}+${name}@${registry}`;
        })
      )
    );
  }

  public get Role(): PromiseLike<Partial<Role>> {
    if (this._role) {
      return Promise.resolve(this._role);
    }
    return this.manage({})
      .then((role) => (this._role = role))
      .then(() => this._policy.manage({}))
      .then(() => this.Role);
  }

  public get RoleId(): PromiseLike<string> {
    return this.Role.then((role) => role.RoleId!);
  }

  public get RoleName(): PromiseLike<string> {
    return this.Role.then((role) => role.RoleName!);
  }

  public get RoleArn(): PromiseLike<string> {
    return this.Role.then((role) => role.Arn!);
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

  constructor(protected req: CRI.PullImageResponse) {
    super(
      {
        describe: (role) => ({ type: 'IAM Role', label: role.Arn }),
        read: async () => this.client.send(new GetRoleCommand({ RoleName: await this._roleName })),
        create: async () =>
          this.client.send(
            new CreateRoleCommand({
              RoleName: await this._roleName,
              AssumeRolePolicyDocument: this.assumeRolePolicyDocument,
            })
          ),
        update: async () =>
          this.client.send(
            new UpdateAssumeRolePolicyCommand({
              RoleName: await this._roleName,
              PolicyDocument: this.assumeRolePolicyDocument,
            })
          ),
        dispose: (role) => this.client.send(new DeleteRoleCommand({ RoleName: role.RoleName })),
      },
      (output) => output.Role
    );

    this._policy = new IamPolicyResource(this);
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
