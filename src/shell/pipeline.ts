import { NEVER, Observable } from 'rxjs';
import { Environment } from '../environment';
import { Pipeline, Request } from '../pipeline';
import { Transport } from '@connectrpc/connect';
import { CRIServices } from '@scaffoldly/rowdy-grpc';

export class ShellPipeline extends Pipeline {
  constructor(environment: Environment) {
    super(environment);
  }

  override into(): Observable<Request<Pipeline>> {
    return NEVER;
  }

  override cri(_transport: Transport): CRIServices {
    throw new Error('Method not implemented.');
  }

  override repr(): string {
    return `ShellPipeline()`;
  }
}
