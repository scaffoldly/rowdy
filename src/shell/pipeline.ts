import { NEVER, Observable } from 'rxjs';
import { Environment } from '../environment';
import { Pipeline, Request } from '../pipeline';
import { CRI, GrpcRouter } from '@scaffoldly/rowdy-grpc';
import { Message } from '@bufbuild/protobuf';

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

  override version(_upgrade?: boolean): Observable<CRI.VersionResponse> {
    throw new Error('Method not implemented.');
  }

  override repr(): string {
    return `ShellPipeline()`;
  }
}
