import { NEVER, Observable } from 'rxjs';
import { Environment } from '../environment';
import { Pipeline, Request } from '../pipeline';
import { CRI, GrpcRouter } from '@scaffoldly/rowdy-grpc';

export class ShellPipeline extends Pipeline {
  constructor(environment: Environment) {
    super(environment);
  }

  override into(): Observable<Request<Pipeline>> {
    return NEVER;
  }

  override get cri(): Observable<GrpcRouter> {
    return NEVER;
  }

  override version(): Observable<CRI.VersionResponse> {
    throw new Error('Method not implemented.');
  }

  override repr(): string {
    return `ShellPipeline()`;
  }
}
