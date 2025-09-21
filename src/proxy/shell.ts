import { NEVER, Observable } from 'rxjs';
import { Response } from '../response';

export class ShellProxy extends Response {
  private constructor(signal: AbortSignal) {
    super(signal);
  }

  static fromLambda(
    _payload: string,
    _signal: AbortSignal
  ): Observable<Response> {
    // TODO: implement
    return NEVER;
  }

  override send(): Observable<this> {
    throw new Error('Method not implemented.');
  }
}
