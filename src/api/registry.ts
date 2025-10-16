import { AxiosInstance } from 'axios';
import { Logger } from '../log';
import { catchError, from, map, Observable, of, switchMap, throwError } from 'rxjs';
import { ApiSchema, IApi, Registry } from './types';

export class RegistryApi {
  constructor(private api: IApi) {}

  get http(): AxiosInstance {
    return this.api.http;
  }

  get log(): Logger {
    return this.api.log;
  }

  private authorize(registry: string): Observable<string> {
    const url = `https://${registry}/v2/`;
    this.log.debug(`Authorizing with registry ${registry} at ${url}`);
    // DEVNOTE: The authenticate interceptor will handle the auth challenge
    return from(this.http.get(url)).pipe(map(({ config }) => config.headers.Authorization as string));
  }

  getRegistry(req: Registry['Req']): Observable<ApiSchema<Registry['Req'], Registry['Res']>> {
    let { registry = req?.registry || this.api.environment.opts.registry, authorization } = req;
    if (!registry) {
      return throwError(() => new Error('Not implemented: Infer default registry'));
    }

    const respond = (
      spec: Registry['Req'],
      status: Registry['Res']
    ): Observable<ApiSchema<Registry['Req'], Registry['Res']>> => {
      this.log.debug(`Registry Spec`, JSON.stringify(spec, null, 2));
      this.log.debug(`Registry Status`, JSON.stringify(status, null, 2));
      return of({
        apiVersion: 'rowdy.run/v1alpha1',
        kind: 'Registry',
        spec,
        status,
      });
    };

    if (!authorization) {
      return this.authorize(registry).pipe(
        switchMap((auth) => respond({ registry }, { registry, authorization: auth, code: 200 })),
        catchError((error) => {
          this.log.error(
            `Failed to authorize with registry ${registry}: ${error instanceof Error ? error.message : String(error)}`
          );
          return respond({ registry }, { registry, authorization: '', code: 401, reason: 'Unauthorized' });
        })
      );
    }

    return respond({ registry, authorization }, { registry, authorization, code: 200 });
  }
}
