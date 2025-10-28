import { NEVER, Observable } from 'rxjs';
import { Environment } from '../environment';
import { Pipeline, Request } from '../pipeline';
import { GrpcRouter } from '@scaffoldly/rowdy-grpc';

export class ShellPipeline extends Pipeline {
  constructor(environment: Environment) {
    super(environment);
  }

  override into(): Observable<Request<Pipeline>> {
    return NEVER;
  }

  override get cri(): GrpcRouter {
    throw new Error('GRPC is not supported in ShellPipeline');
  }

  override repr(): string {
    return `ShellPipeline()`;
  }
}
