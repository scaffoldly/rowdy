import { Observable } from 'rxjs';
import { Response } from './response';

export abstract class Request {
  constructor(protected readonly signal: AbortSignal) {}

  abstract into(): Observable<Response>;
}
