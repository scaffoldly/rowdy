import { Observable } from 'rxjs';
import { PassThrough } from 'stream';

export class Prelude {
  statusCode?: number;
  headers?: Record<string, unknown>;
  cookies?: string[];
}

export abstract class Response {
  readonly prelude: Prelude = {};
  readonly data: PassThrough = new PassThrough();

  constructor(protected readonly signal: AbortSignal) {}

  abstract send(): Observable<this>;
}
