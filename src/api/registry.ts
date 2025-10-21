import { AxiosInstance } from 'axios';
import { Logger } from '../log';
import { catchError, combineLatest, from, map, NEVER, Observable, of, race, switchMap, throwError } from 'rxjs';
import { ApiSchema, IApi, Registry } from './types';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

export class RegistryApi {
  private _default?: Required<Registry['Req']>;

  constructor(private api: IApi) {}

  get http(): AxiosInstance {
    return this.api.http;
  }

  get log(): Logger {
    return this.api.log;
  }

  infer(): Observable<RegistryApi> {
    if (this.api.environment?.opts.registry) {
      const api = this._default ? this : new RegistryApi(this.api);
      api._default = {
        registry: this.api.environment.opts.registry,
        authorization: '',
      };
      return api.login();
    }
    return race([
      // TODO: More Registry types
      this.localhost(),
      this.aws(),
    ]).pipe(switchMap((api) => api.login()));
  }

  private login(): Observable<this> {
    const { _default } = this;
    if (!_default) {
      return throwError(() => new Error('Use infer() before login()'));
    }

    const { registry } = _default;

    this.log.debug(`Logging in to registry ${registry}...`);
    return from(this.api.http.get(`https://${registry}/v2/`)).pipe(
      map((res) => {
        this.log.debug(`Logged in to registry ${registry} with status ${res.status}`, {
          headers: JSON.stringify(res.config.headers),
        });
        _default.authorization = res.config.headers?.get('Authorization') as string;
        this._default = _default;
        return this;
      })
    );
  }

  private localhost(): Observable<this> {
    // TODO: Implement localhost registry inference
    return NEVER;
  }

  private aws(): Observable<this> {
    const sts = new STSClient({});
    return combineLatest([from(sts.send(new GetCallerIdentityCommand({}))), from(sts.config.region())]).pipe(
      map(([{ Account }, region]) => `${Account}.dkr.ecr.${region}.amazonaws.com`),
      map((registry) => {
        this.log.debug(`Inferred AWS ECR Registry: ${registry}`);
        this._default = { registry, authorization: '' };
        return this;
      }),
      catchError((error) => {
        this.log.debug(`Unable to infer AWS ECR Registry: ${error instanceof Error ? error.message : String(error)}`);
        return NEVER;
      })
    );
  }

  getRegistry(req?: Registry['Req']): Observable<ApiSchema<Registry['Req'], Registry['Res']>> {
    const { registry, authorization } = req || {};
    if (!registry) {
      const api = new RegistryApi(this.api);
      return api.infer().pipe(switchMap((api) => api.getRegistry(api._default!)));
    }

    if (!authorization) {
      const api = new RegistryApi(this.api);
      api._default = { registry, authorization: '' };
      return api.login().pipe(switchMap((api) => api.getRegistry(api._default!)));
    }

    const spec: Registry['Req'] = { registry };
    const status: Registry['Res'] = { registry, code: 200 };

    this.log.debug(`Registry Spec`, JSON.stringify(spec, null, 2));
    this.log.debug(`Registry Status`, JSON.stringify(status, null, 2));

    return of({
      apiVersion: 'rowdy.run/v1alpha1',
      kind: 'Registry',
      spec,
      status,
    });
  }
}
