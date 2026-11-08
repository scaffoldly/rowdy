import { randomUUID } from 'crypto';
import { chmod, mkdir, open, readFile, writeFile } from 'fs/promises';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { dirname, resolve } from 'path';
import { catchError, defer, from, map, NEVER, Observable, of } from 'rxjs';
import { buffer, text } from 'stream/consumers';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../environment';
import { log as root, Trace } from '../log';
import { Chunk, Pipeline, Proxy, Request, Response, Result } from '../pipeline';
import { EXEC_CONTENT_TYPE, EXEC_STREAM, execFrame, ShellProxy, ShellRequest, ShellResponse } from '../proxy/shell';
import { isExecEvent } from './lambda';
import { URI } from '../routes';
import { EXEC_ID_HEADER, EXEC_PATH, FILES_PATH, HOOKS_PORT } from './microvm/hooks';

const log = root.child('microvm');

export { EXEC_ID_HEADER, EXEC_PATH, FILES_PATH, HOOKS_PORT };

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
    public readonly req: IncomingMessage,
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

  private get files(): URLSearchParams | undefined {
    const url = URI.from(`http://localhost${this.req.url ?? ''}`);
    return url.pathname === FILES_PATH ? url.searchParams : undefined;
  }

  @Trace(log)
  override into(): Observable<Proxy<MicrovmPipeline, number | ShellResponse | MicrovmFile>> {
    const { files } = this;
    if (files) {
      return of(new MicrovmFileProxy(this.pipeline, this, files));
    }
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

        const { cmd, args = [], cwd, env, detached } = event.spec!;
        const request = new ShellRequest(this.pipeline, [cmd, ...args], { cwd, env });
        // A command gets no input: a read would otherwise wait on stdin forever.
        request.fds.stdin.end();
        return new MicrovmShellProxy(this.pipeline, request, this, detached).background();
      })
    );
  }

  override brief(): Record<string, string | number | boolean> {
    return { hook: this.isExec ? 'exec' : this.files ? 'files' : (this.hook ?? 'unknown') };
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

type MicrovmFile = { status: number; body?: Buffer; headers?: Record<string, string> };

export class MicrovmFileProxy extends Proxy<MicrovmPipeline, MicrovmFile> {
  constructor(
    pipeline: MicrovmPipeline,
    private readonly hook: MicrovmRequest,
    private readonly query: URLSearchParams
  ) {
    super(pipeline, hook);
  }

  override invoke(): Observable<MicrovmFile> {
    const { req } = this.hook;
    const path = this.query.get('path');
    const mode = this.query.get('mode');

    return defer(async (): Promise<MicrovmFile> => {
      if (!path || (mode !== null && !/^[0-7]{1,4}$/.test(mode))) {
        req.resume();
        return { status: 400, body: Buffer.from('path is required, and mode is octal') };
      }
      const target = resolve(path);
      if (req.method === 'GET') {
        // `bytes=start-end`, end inclusive and optional. A range it can't read is ignored, as HTTP allows.
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        if (!range || (range[2] !== '' && Number(range[2]) < Number(range[1]))) {
          return { status: 200, body: await readFile(target) };
        }
        const file = await open(target);
        try {
          const { size } = await file.stat();
          const start = Number(range[1]);
          if (start >= size) return { status: 416, headers: { 'content-range': `bytes */${size}` } };
          const length = Math.min(range[2] === '' ? size : Number(range[2]) + 1, size) - start;
          const { buffer: read, bytesRead } = await file.read(Buffer.alloc(length), 0, length, start);
          return {
            status: 206,
            body: read.subarray(0, bytesRead),
            headers: { 'content-range': `bytes ${start}-${start + bytesRead - 1}/${size}` },
          };
        } finally {
          await file.close();
        }
      }
      if (req.method === 'PUT') {
        const body = await buffer(req);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, body);
        if (mode !== null) await chmod(target, parseInt(mode, 8));
        return { status: 204 };
      }
      if (req.method === 'POST') {
        req.resume();
        await mkdir(target, { recursive: true });
        if (mode !== null) await chmod(target, parseInt(mode, 8));
        return { status: 204 };
      }
      req.resume();
      return { status: 405 };
    }).pipe(
      catchError((error: NodeJS.ErrnoException) =>
        of({ status: error.code === 'ENOENT' ? 404 : 500, body: Buffer.from(error.message) })
      )
    );
  }

  @Trace(log)
  override into(): Observable<Response<MicrovmPipeline>> {
    return this.invoke().pipe(
      map(({ status, body, headers }) => {
        const response = new MicrovmResponse(this.pipeline, this.hook).withStatus(status);
        Object.entries(headers ?? {}).forEach(([name, value]) => response.withHeader(name, value));
        if (body) {
          response.withHeader('content-type', 'application/octet-stream').next(new Chunk(body, body.length));
        }
        response.complete();
        return response;
      })
    );
  }

  // A file's path can say what's in it, so it isn't logged.
  override repr(): string {
    return `MicrovmFileProxy(method=${this.hook.req.method})`;
  }
}

export class MicrovmShellProxy extends ShellProxy<MicrovmPipeline> {
  constructor(
    pipeline: MicrovmPipeline,
    request: ShellRequest<MicrovmPipeline>,
    private readonly hook: MicrovmRequest,
    private readonly detached = false
  ) {
    super(pipeline, request);
  }

  @Trace(log)
  override into(): Observable<Response<MicrovmPipeline>> {
    return this.invoke().pipe(
      map((shell) => {
        const cmdId = randomUUID();
        const response = new MicrovmResponse(this.pipeline, this.hook)
          .withHeader('content-type', EXEC_CONTENT_TYPE)
          .withHeader(EXEC_ID_HEADER, cmdId);
        this.multiplex(cmdId, shell, response);

        // A hang-up is how a signal reaches a command. A detached one runs on with its log, and stops buffering frames
        // nobody will read.
        const { res } = this.hook;
        const hungUp = (): void => {
          if (res.writableFinished) return;
          if (this.detached) response.complete();
          else shell.kill();
        };
        if (res.destroyed) hungUp();
        else res.once('close', hungUp);

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

      // Frames still in flight when a caller hangs up have nowhere to go.
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
