import { catchError, combineLatest, from, map, MonoTypeOperatorFunction, NEVER, Observable, of, switchMap } from 'rxjs';
import { IRegistryApi, TRegistry } from '../api/types';
import {
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
} from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { Environment } from '../environment';

const ECR_REGISTRY_REGEX = /\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com?$/;

export class AwsRegistry implements IRegistryApi {
  private ecr: ECRClient = new ECRClient({});
  private sts: STSClient = new STSClient({});

  constructor(private enviornment?: Environment) {}

  withSlug(slug: string): MonoTypeOperatorFunction<TRegistry> {
    return (source) =>
      from(this.ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [slug] }))).pipe(
        switchMap(() => source),
        catchError(() =>
          from(this.ecr.send(new CreateRepositoryCommand({ repositoryName: slug }))).pipe(switchMap(() => source))
        )
      );
  }

  login(): Observable<TRegistry> {
    const { registry = process.env.AWS_ECR_REGISTRY } = this.enviornment?.opts || {};

    if (registry && !registry.match(ECR_REGISTRY_REGEX)) {
      return NEVER;
    }

    return of(registry).pipe(
      switchMap((registry) => (registry ? of(registry) : this.default)),
      switchMap((registry) =>
        from(this.ecr.send(new GetAuthorizationTokenCommand())).pipe(
          map((res) => {
            const token = res.authorizationData?.[0]?.authorizationToken;
            const result: TRegistry = {
              registry,
              authorization: `Basic ${token}`,
              withSlug: (slug: string) => this.withSlug(slug)(of(result)),
            };
            return result;
          })
        )
      ),
      catchError(() => NEVER)
    );
  }

  private get default(): Observable<string> {
    return combineLatest([from(this.ecr.config.region()), from(this.sts.send(new GetCallerIdentityCommand({})))]).pipe(
      map(([region, { Account }]) => {
        return `${Account}.dkr.ecr.${region}.amazonaws.com`;
      })
    );
  }
}
