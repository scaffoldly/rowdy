import { defer, from, map, NEVER, Observable, of, race, switchMap, tap } from 'rxjs';
import { Proxy, Pipeline, Request, Response, Result, Chunk } from '../pipeline';
import { Environment } from '../environment';
import axios from 'axios';
import { log, Trace } from '../log';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { HttpProxy, HttpHeaders, HttpResponse, Source } from '../proxy/http';
import { ShellResponse } from '../proxy/shell';
import { PassThrough } from 'stream';
import { URI } from '../routes';
import { CRI, GrpcRouter, RuntimeService } from '@scaffoldly/rowdy-grpc';
import { LambdaCri } from './lambda/cri';

type FunctionUrlEvent = APIGatewayProxyEventV2;

const isFunctionUrlEvent = (data: unknown): data is FunctionUrlEvent => {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const event = data as Partial<APIGatewayProxyEventV2>;
  return (
    event.version === '2.0' && event.routeKey === '$default' && !!event.requestContext && !!event.requestContext.http
  );
};

export class LambdaPipeline extends Pipeline {
  public readonly runtimeApi: string | undefined = process.env.AWS_LAMBDA_RUNTIME_API;

  private _requestId: string | undefined;

  constructor(environment: Environment) {
    super(environment);

    if (!this.runtimeApi) {
      return;
    }

    let router = new GrpcRouter(this.signal, {
      title: 'AWS Lambda CRI',
      description: `An implementation of the Kubernetes Container Runtime Interface (CRI) which leverages technology such as AWS Lambda, AWS ECR, and AWS CloudWatch to implement Container Runtime and Image management.`,
      license: {
        name: 'FSL-1.1-Apache-2.0',
      },
      version: this.environment.version,
    }).withServices(new LambdaCri(this.environment));

    return this.withRouter(router);
  }

  get requestId(): string {
    if (!this._requestId) {
      throw new Error('No Request ID');
    }
    return this._requestId;
  }

  override get name(): string {
    return this.constructor.name;
  }

  @Trace
  override into(): Observable<Request<LambdaPipeline>> {
    if (!this.runtimeApi) {
      log.debug('Lambda Pipeline: DISABLED: No AWS_LAMBDA_RUNTIME_API environment variable');
      return NEVER;
    }

    const url = `http://${this.runtimeApi}/2018-06-01/runtime/invocation/next`;

    return defer(() => {
      log.debug(`Fetching next invocation`, { url });
      return axios.get<string>(url, { responseType: 'text', signal: this.signal, timeout: 0 });
    }).pipe(
      map(({ data, headers }) => {
        this._requestId = headers['lambda-runtime-aws-request-id'];
        return new LambdaRequest(this, data).withDeadline(headers['lambda-runtime-deadline-ms']);
      })
    );
  }

  override version(): Observable<CRI.VersionResponse> {
    return this.router.pipe(
      switchMap((router) => RuntimeService.client(router.local).version({ version: this.environment.version }))
    );
  }

  override repr(): string {
    return `LambdaPipeline(runtimeApi=${this.runtimeApi})`;
  }
}

export class LambdaRequest extends Request<LambdaPipeline> {
  constructor(
    pipeline: LambdaPipeline,
    public readonly data: string
  ) {
    super(pipeline);
  }

  @Trace
  override into(): Observable<Proxy<LambdaPipeline, HttpResponse | ShellResponse>> {
    return race([this.intoHttp(), this.intoShell()]);
  }

  @Trace
  protected intoHttp(): Observable<Proxy<LambdaPipeline, HttpResponse>> {
    let data: unknown;

    try {
      data = JSON.parse(this.data);
    } catch (error) {
      log.debug(`Not JSON: ${error instanceof Error ? error.message : String(error)}`, {
        data: this.data,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return NEVER;
    }

    if (isFunctionUrlEvent(data)) {
      const { body, headers, requestContext, isBase64Encoded, rawPath, rawQueryString } = data;
      const { method } = requestContext.http;

      const host = headers['Host'] || headers['host'] || 'localhost';
      const hostname = headers['X-Forwarded-Host'] || headers['x-forwarded-host'] || host;
      const proto = headers['X-Forwarded-Proto'] || headers['x-forwarded-proto'] || 'https';
      const userAgent = headers['User-Agent'] || headers['user-agent'] || this.pipeline.environment.userAgent;

      this.pipeline.environment
        .withEnv('HTTP_HOST', host)
        .withEnv('HTTP_HOSTNAME', hostname)
        .withEnv('HTTP_PROTO', proto)
        .withEnv(
          'HTTP_UA',
          `${userAgent} (${this.pipeline.environment.name} v${this.pipeline.environment.version} ${this.pipeline.name})`
        );

      const source: Source = {
        method,
        uri: URI.from(`${proto}://${hostname}${rawPath}${rawQueryString ? `?${rawQueryString}` : ''}`),
        headers,
      };

      let uri: URI;
      try {
        uri = this.pipeline.routes.intoURI(rawPath);
      } catch (error) {
        uri = URI.fromError(error instanceof Error ? error : new Error(String(error)), 500);
      }

      if (rawQueryString) {
        uri.withSearch(new URLSearchParams(rawQueryString));
      }

      return of(
        new LambdaHttpProxy(
          this.pipeline,
          this,
          method,
          uri,
          HttpHeaders.fromLambda(headers),
          isBase64Encoded ? Buffer.from(body || '', 'base64') : Buffer.from(body || ''),
          source
        )
      );
    }

    log.warn('Unsupported HTTP Event', { data: this.data });
    return NEVER;
  }

  @Trace
  protected intoShell(): Observable<Proxy<LambdaPipeline, ShellResponse>> {
    return NEVER;
  }

  override repr(): string {
    return `LambdaRequest(data=${this.data})`;
  }
}

export class LambdaHttpProxy extends HttpProxy<LambdaPipeline> {
  @Trace
  override into(): Observable<Response<LambdaPipeline>> {
    return this.invoke().pipe(
      map((http) => {
        const response = new LambdaResponse(this.pipeline, this.request);
        const { cancel: cancelDeadline } = this.request.onDeadline(() => {
          log.warn('LambdaHttpProxy Request Deadline Reached', { requestId: this.pipeline.requestId });
          response.error(new Error('Request deadline reached'));
          http.data.destroy(new Error('Request deadline reached'));
        });
        // Set to 0 bytes as the prelude is not counted
        response.next(new Chunk(JSON.stringify(http.prelude()), 0));
        response.next(new Chunk(Buffer.alloc(8), 0));
        http.data.on('data', (chunk: Buffer) => response.next(new Chunk(chunk, chunk.length)));
        http.data.on('end', () => cancelDeadline(() => response.complete()));
        http.data.on('close', () => cancelDeadline(() => response.complete()));
        http.data.on('error', (error: Error) => cancelDeadline(() => response.error(error)));
        return response;
      })
    );
  }
}

export class LambdaResponse extends Response<LambdaPipeline> {
  private chunks: number = 0;
  private bytes: number = 0;

  private writeChunk(stream: PassThrough, data: Buffer | string): void {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length === 0) return;
    stream.write(`${buffer.length.toString(16)}\r\n`);
    stream.write(buffer);
    stream.write('\r\n');
  }

  private writeTrailers(stream: PassThrough, trailers?: { errorType?: string; errorBody?: string }): void {
    // Write terminating chunk
    stream.write('0\r\n');
    // Write trailer headers if present
    if (trailers?.errorType) {
      stream.write(`Lambda-Runtime-Function-Error-Type: ${trailers.errorType}\r\n`);
    }
    if (trailers?.errorBody) {
      stream.write(`Lambda-Runtime-Function-Error-Body: ${Buffer.from(trailers.errorBody).toString('base64')}\r\n`);
    }
    // Final CRLF to end trailers section
    stream.write('\r\n');
  }

  @Trace
  override into(): Observable<Result<LambdaPipeline>> {
    const data = new PassThrough();

    const subscription = this.subscribe({
      next: (chunk) => {
        log.debug(`LambdaResponse Chunk`, { responseBytes: chunk.bytes, length: chunk.data.length });
        this.bytes += chunk.bytes;
        if (!chunk.data.length) {
          return;
        }
        this.chunks += 1;
        this.writeChunk(data, chunk.data);
      },
      error: (error) => {
        log.warn(`LambdaResponse Error`, { error, isAxiosError: axios.isAxiosError(error) });
        this.writeTrailers(data, {
          errorType: 'Runtime.Error',
          errorBody: error instanceof Error ? error.message : String(error),
        });
        data.end();
      },
      complete: () => {
        log.debug(`LambdaResponse Complete`, { chunks: this.chunks, responseBytes: this.bytes });
        this.writeTrailers(data);
        data.end();
      },
    });

    return from(
      axios
        .post(
          `http://${this.pipeline.runtimeApi}/2018-06-01/runtime/invocation/${this.pipeline.requestId}/response`,
          data,
          {
            headers: {
              'Content-Type': 'application/vnd.awslambda.http-integration-response',
              'Lambda-Runtime-Function-Response-Mode': 'streaming',
              Trailer: 'Lambda-Runtime-Function-Error-Type, Lambda-Runtime-Function-Error-Body',
            },
            maxBodyLength: 20 * 1024 * 1024,
            maxContentLength: Infinity,
            timeout: 0,
            signal: this.signal,
            onUploadProgress: (event) => {
              log.debug(`Upload Progess`, { bytes: event.bytes, loaded: event.loaded, total: event.total });
            },
          }
        )
        .then(() => new Result(this.pipeline, this.request, true, this.bytes))
        .catch((error) => {
          log.warn(`LambdaResponse.into() Axios Error`, { error, isAxiosError: axios.isAxiosError(error) });
          throw error; // TODO: return result
          // return new Result(this.pipeline, false, this.bytes);
        })
    ).pipe(tap(() => subscription.unsubscribe()));
  }

  override repr(): string {
    return `LambdaResponse(requestId=${this.pipeline.requestId}, chunks=${this.chunks}, bytes=${this.bytes})`;
  }
}
