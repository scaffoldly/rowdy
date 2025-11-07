import { NEVER, Observable } from 'rxjs';
import { IRegistryApi, TRegistry } from '../api/types';

export class LocalRegistry implements IRegistryApi {
  login(): Observable<TRegistry> {
    return NEVER;
  }
}
