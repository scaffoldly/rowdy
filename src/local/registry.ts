import { MonoTypeOperatorFunction, NEVER, Observable } from 'rxjs';
import { IRegistryApi, TRegistry } from '../api/types';

export class LocalRegistry implements IRegistryApi {
  login(): Observable<TRegistry> {
    return NEVER;
  }
  withSlug(_slug: string): MonoTypeOperatorFunction<TRegistry> {
    return (source) => source;
  }
}
