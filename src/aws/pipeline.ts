import { defer, from, map, NEVER, Observable, of, race, switchMap, tap } from 'rxjs';
import { Proxy, Pipeline, Request, Response, Result } from '../pipeline';
import { Environment } from '../environment';
import axios from 'axios';
import { log, Trace } from '../log';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { HttpProxy } from '../proxy/http';
import { ShellResponse } from '../proxy/shell';
import { PassThrough } from 'stream';
import { HttpHeaders, HttpResponse } from '../proxy';

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
  }

  get requestId(): string {
    if (!this._requestId) {
      throw new Error('No Request ID');
    }
    return this._requestId;
  }

  @Trace
  override into(): Observable<Request<LambdaPipeline>> {
    return of(this.runtimeApi).pipe(
      switchMap((api) => {
        if (!api) {
          log.debug('Lambda Pipeline: DISABLED');
          return NEVER;
        }

        const url = `http://${this.runtimeApi}/2018-06-01/runtime/invocation/next`;

        return defer(() => {
          log.debug(`Fetching next invocation`, { url });
          return axios.get<string>(url, { responseType: 'text', signal: this.signal, timeout: 0 });
        }).pipe(
          map(({ data, headers }) => {
            this._requestId = headers['lambda-runtime-aws-request-id'];
            return new LambdaRequest(this, data);
          })
        );
      })
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
    try {
      const data = JSON.parse(this.data);

      if (isFunctionUrlEvent(data)) {
        const { body, headers, requestContext, isBase64Encoded, rawPath, rawQueryString } = data;
        const { method } = requestContext.http;

        const url = this.pipeline.routes.intoURI(rawPath);
        if (!url) {
          throw new Error('No matching route');
        }

        if (rawQueryString) {
          url.search = new URLSearchParams(rawQueryString).toString();
        }

        return of(
          new LambdaHttpProxy(
            this.pipeline,
            method,
            url,
            HttpHeaders.fromLambda(headers),
            isBase64Encoded ? Buffer.from(body || '', 'base64') : Buffer.from(body || '')
          )
        );
      }

      log.warn('Unsupported HTTP Event', { data: this.data });
    } catch (error) {
      log.debug(`Not an HTTP Event: ${error instanceof Error ? error.message : String(error)}`, {
        data: this.data,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }

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
        const response = new LambdaResponse(this.pipeline);
        response.next(JSON.stringify(http.prelude()));
        response.next(Buffer.alloc(8));
        http.data.on('data', (chunk: Buffer) => response.next(chunk));
        http.data.on('end', () => response.complete());
        return response;
      })
    );
  }
}

export class LambdaResponse extends Response<LambdaPipeline> {
  private chunks: number = 0;
  private bytes: number = 0;

  @Trace
  override into(): Observable<Result<LambdaPipeline>> {
    const data = new PassThrough();

    const subscription = this.subscribe({
      next: (chunk) => {
        if (!chunk.length) return;
        this.chunks += 1;
        data.write(chunk);
      },
      complete: () => {
        if (!this.chunks) data.write('\0');
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
              'Transfer-Encoding': 'chunked',
              Trailer: ['Lambda-Runtime-Function-Error-Type', 'Lambda-Runtime-Function-Error-Body'],
            },
            maxBodyLength: 20 * 1024 * 1024,
            timeout: 0,
            signal: this.signal,
            onUploadProgress: (event) => {
              log.debug(`Upload Progess`, { bytes: event.bytes, loaded: event.loaded, total: event.total });
              this.bytes += event.bytes;
            },
          }
        )
        .then(() => new Result(this.pipeline, true, this.bytes))
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
