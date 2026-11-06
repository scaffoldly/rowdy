import { createServer, IncomingMessage, ServerResponse } from 'http';
import { defer, map, NEVER, Observable, of } from 'rxjs';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../environment';
import { log as root, Trace } from '../log';
import { Pipeline, Proxy, Request, Response, Result } from '../pipeline';

const log = root.child('microvm');

/** The port an image's hook configuration must name: the first of Linux's ephemeral range, clear of a user's server. */
export const HOOKS_PORT = 32768;

const HOOKS_PATH = '/aws/lambda-microvms/runtime/v1/';
const HOOKS: ReadonlySet<string> = new Set(['ready', 'validate', 'run']);

export class MicrovmPipeline extends Pipeline {
  public readonly imageArn: string | undefined = process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN;

  constructor(
    environment: Environment,
    private readonly port = HOOKS_PORT
  ) {
    super(environment);
  }

  override get name(): string {
    return this.constructor.name;
  }

  @Trace(log)
  override into(): Observable<Request<MicrovmPipeline>> {
    const { imageArn, port } = this;
    if (!imageArn) {
      log.debug('MicroVM Pipeline: DISABLED: No AWS_LAMBDA_MICROVM_IMAGE_ARN environment variable');
      return NEVER;
    }

    // Emits every hook and never completes: closing the server between hooks would refuse the next.
    return new Observable((subscriber) => {
      const server = createServer((req, res) => {
        req.resume();
        subscriber.next(new MicrovmRequest(this, req, res));
      });
      server.once('error', (error) => subscriber.error(error));
      server.listen(port, () => log.info('Hooks Listening', { port }));
      return () => {
        server.close();
        server.closeAllConnections();
      };
    });
  }

  override version(): Observable<CRI.VersionResponse> {
    throw new Error('Method not implemented.');
  }

  override repr(): string {
    return `MicrovmPipeline(imageArn=${this.imageArn}, port=${this.port})`;
  }
}

export class MicrovmRequest extends Request<MicrovmPipeline> {
  constructor(
    pipeline: MicrovmPipeline,
    private readonly req: IncomingMessage,
    public readonly res: ServerResponse
  ) {
    super(pipeline);
  }

  /** The hook's name, or undefined for a path that is not a hook rowdy serves. */
  get hook(): string | undefined {
    const { url = '' } = this.req;
    const hook = url.startsWith(HOOKS_PATH) ? url.slice(HOOKS_PATH.length) : undefined;
    return hook && HOOKS.has(hook) ? hook : undefined;
  }

  @Trace(log)
  override into(): Observable<Proxy<MicrovmPipeline, number>> {
    return of(new MicrovmHookProxy(this.pipeline, this));
  }

  override brief(): Record<string, string | number | boolean> {
    return { hook: this.hook ?? 'unknown' };
  }

  override repr(): string {
    return `MicrovmRequest(hook=${this.hook ?? 'unknown'})`;
  }
}

export class MicrovmHookProxy extends Proxy<MicrovmPipeline, number> {
  constructor(
    pipeline: MicrovmPipeline,
    private readonly hook: MicrovmRequest
  ) {
    super(pipeline, hook);
  }

  override invoke(): Observable<number> {
    return of(this.hook.hook ? 200 : 404);
  }

  @Trace(log)
  override into(): Observable<Response<MicrovmPipeline>> {
    return this.invoke().pipe(map((status) => new MicrovmResponse(this.pipeline, this.hook).withStatus(status)));
  }

  override repr(): string {
    return `MicrovmHookProxy(hook=${this.hook.hook ?? 'unknown'})`;
  }
}

export class MicrovmResponse extends Response<MicrovmPipeline> {
  private status = 200;

  constructor(
    pipeline: MicrovmPipeline,
    private readonly hook: MicrovmRequest
  ) {
    super(pipeline, hook);
  }

  withStatus(status: number): this {
    this.status = status;
    return this;
  }

  // A hook must answer at once: AWS ends the build if its timeout passes during an open request.
  @Trace(log)
  override into(): Observable<Result<MicrovmPipeline>> {
    return defer(() => {
      const { status } = this;
      this.hook.res.writeHead(status).end();
      return of(new Result(this.pipeline, this.request, status < 400, 0, status));
    });
  }

  override repr(): string {
    return `MicrovmResponse(status=${this.status})`;
  }
}
