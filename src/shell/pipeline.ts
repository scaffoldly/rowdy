import { NEVER, Observable } from 'rxjs';
import { Environment } from '../environment';
import { Pipeline, Request } from '../pipeline';
import { CRI } from '@scaffoldly/rowdy-grpc';

export class ShellPipeline extends Pipeline {
  constructor(environment: Environment) {
    super(environment);
  }

  override into(): Observable<Request<Pipeline>> {
    return NEVER;
  }

  override get name(): string {
    return this.constructor.name;
  }

  override version(): Observable<CRI.VersionResponse> {
    throw new Error('Method not implemented.');
  }

  override repr(): string {
    return `ShellPipeline()`;
  }
}
