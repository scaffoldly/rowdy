import { randomUUID } from 'crypto';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { defer, from, map, NEVER, Observable, of } from 'rxjs';
import { text } from 'stream/consumers';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../environment';
import { log as root, Trace } from '../log';
import { Pipeline, Proxy, Request, Response, Result } from '../pipeline';
import { EXEC_CONTENT_TYPE, EXEC_STREAM, execFrame, ShellProxy, ShellRequest, ShellResponse } from '../proxy/shell';
import { isExecEvent } from './lambda';

const log = root.child('microvm');

/** The port an image's hook configuration must name: the first of Linux's ephemeral range, clear of a user's server. */
export const HOOKS_PORT = 32768;

const HOOKS_PATH = '/aws/lambda-microvms/runtime/v1/';
const HOOKS: ReadonlySet<string> = new Set(['ready', 'validate', 'run']);

/** Takes an Exec event. Apart from the hooks, which a holder of a VM's auth token can also reach. */
export const EXEC_PATH = '/rowdy/exec';

/** Carries a command's id on the response whose body is its frames. */
export const EXEC_ID_HEADER = 'x-rowdy-cmd-id';

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
      const server = createServer((req, res) => subscriber.next(new MicrovmRequest(this, req, res)));
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

  private get isExec(): boolean {
    return this.req.url === EXEC_PATH;
  }

  @Trace(log)
  override into(): Observable<Proxy<MicrovmPipeline, number | ShellResponse>> {
    if (!this.isExec) {
      this.req.resume();
      return of(new MicrovmHookProxy(this.pipeline, this, this.hook ? 200 : 404));
    }

    return from(text(this.req)).pipe(
      map((body) => {
        let event: unknown;
        try {
          event = JSON.parse(body);
        } catch {
          return new MicrovmHookProxy(this.pipeline, this, 400);
        }
        if (!isExecEvent(event)) {
          return new MicrovmHookProxy(this.pipeline, this, 400);
        }

        const { cmd, args = [], cwd, env } = event.spec!;
        const request = new ShellRequest(this.pipeline, [cmd, ...args], { cwd, env });
        // A command gets no input: a read would otherwise wait on stdin forever.
        request.fds.stdin.end();
        return new MicrovmShellProxy(this.pipeline, request, this).background();
      })
    );
  }

  override brief(): Record<string, string | number | boolean> {
    return { hook: this.isExec ? 'exec' : (this.hook ?? 'unknown') };
  }

  override repr(): string {
    return `MicrovmRequest(hook=${this.brief().hook})`;
  }
}

export class MicrovmHookProxy extends Proxy<MicrovmPipeline, number> {
  constructor(
    pipeline: MicrovmPipeline,
    private readonly hook: MicrovmRequest,
    private readonly status: number
  ) {
    super(pipeline, hook);
  }

  override invoke(): Observable<number> {
    return of(this.status);
  }

  @Trace(log)
  override into(): Observable<Response<MicrovmPipeline>> {
    return this.invoke().pipe(
      map((status) => {
        const response = new MicrovmResponse(this.pipeline, this.hook).withStatus(status);
        response.complete();
        return response;
      })
    );
  }

  override repr(): string {
    return `MicrovmHookProxy(hook=${this.hook.brief().hook}, status=${this.status})`;
  }
}

export class MicrovmShellProxy extends ShellProxy<MicrovmPipeline> {
  constructor(
    pipeline: MicrovmPipeline,
    request: ShellRequest<MicrovmPipeline>,
    private readonly hook: MicrovmRequest
  ) {
    super(pipeline, request);
  }

  @Trace(log)
  override into(): Observable<Response<MicrovmPipeline>> {
    return this.invoke().pipe(
      map((shell) => {
        const response = new MicrovmResponse(this.pipeline, this.hook)
          .withHeader('content-type', EXEC_CONTENT_TYPE)
          .withHeader(EXEC_ID_HEADER, randomUUID());
        this.multiplex(shell, response);
        return response;
      })
    );
  }
}

export class MicrovmResponse extends Response<MicrovmPipeline> {
  private status = 200;
  private headers: Record<string, string> = {};

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

  withHeader(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  // Emits before the body is done: a pipeline stage held for a command's whole run would queue every other request
  // behind it on a one-CPU VM. A hook must also answer at once: AWS ends the build if its timeout passes during an
  // open request.
  @Trace(log)
  override into(): Observable<Result<MicrovmPipeline>> {
    return defer(() => {
      const { status, headers } = this;
      const { res } = this.hook;

      // A caller that hangs up leaves the command running, with nowhere for its frames to go.
      res.on('error', () => {});
      res.writeHead(status, headers);
      res.flushHeaders();

      this.subscribe({
        next: ({ data }) => res.write(data),
        error: (error: Error) => {
          res.write(execFrame(EXEC_STREAM.EXIT, Buffer.from(JSON.stringify({ code: 1, message: error.message }))));
          res.end();
        },
        complete: () => res.end(),
      });

      return of(new Result(this.pipeline, this.request, status < 400, 0, status));
    });
  }

  override repr(): string {
    return `MicrovmResponse(status=${this.status})`;
  }
}
