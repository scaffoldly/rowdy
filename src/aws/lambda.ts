import { AsyncSubject, defer, map, NEVER, Observable, of, race, switchMap, tap } from 'rxjs';
import { Proxy, Pipeline, Request, Response, Result, Chunk } from '../pipeline';
import { Environment } from '../environment';
import axios from 'axios';
import { log, Trace } from '../log';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { HttpProxy, HttpHeaders, HttpResponse, Source } from '../proxy/http';
import { ShellResponse } from '../proxy/shell';
import { Crontab, CronSchema, URI } from '../routes';
import { CRI, GrpcRouter, RuntimeService } from '@scaffoldly/rowdy-grpc';
import { LambdaCri } from './lambda/cri';
import { Rowdy } from '../api';
import http from 'http';

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

const isCronEvent = (data: unknown): data is CronSchema => {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const event = data as Partial<CronSchema>;
  return event.apiVersion === 'rowdy.run/v1alpha1' && event.kind === 'Cron' && typeof event.spec?.line === 'string';
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
        const deadline = headers['lambda-runtime-deadline-ms'];
        log.debug(`Received invocation`, { requestId: this._requestId, deadline, data });
        return new LambdaRequest(this, data).withDeadline(new Date(Number(deadline)));
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

      // DEVNOTE: X-Rowdy-Cron is rowdy's own signal that a request came from one of its schedules.
      // Strip any inbound value so a caller cannot forge it through the Function URL.
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === Rowdy.HEADERS.CRON) {
          delete headers[key];
        }
      }

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

    if (isCronEvent(data)) {
      return this.intoCron(data);
    }

    log.warn('Unsupported HTTP Event', { data: this.data });
    return NEVER;
  }

  protected intoCron(event: CronSchema): Observable<Proxy<LambdaPipeline, HttpResponse>> {
    const line = event.spec?.line || '';

    const source: Source = {
      method: 'GET',
      uri: URI.from(`rowdy://${Rowdy.CRON}/`),
      headers: {},
    };

    const fail = (message: string): Observable<Proxy<LambdaPipeline, HttpResponse>> => {
      log.warn(message, { line });
      return of(
        new LambdaCronProxy(
          this.pipeline,
          this,
          'GET',
          URI.fromError(new Error(message), 500),
          HttpHeaders.from({}),
          Buffer.alloc(0),
          source
        )
      );
    };

    let cron: Crontab;
    try {
      cron = Crontab.parse(line);
    } catch (error) {
      return fail(`Unparseable Cron Event: ${error instanceof Error ? error.message : String(error)}`);
    }

    // DEVNOTE: Only ever run what this deployment's own manifest declares, so a schedule that
    // reconciliation missed is harmless.
    if (!this.pipeline.routes.crontab.includes(cron.line)) {
      return fail(`Unknown Cron Event, not declared in spec.crontab`);
    }

    const uri = cron.uriRef;
    const userAgent = `${this.pipeline.environment.userAgent} (cron)`;

    this.pipeline.environment
      .withEnv('HTTP_HOST', uri.host)
      .withEnv('HTTP_HOSTNAME', uri.hostname)
      .withEnv('HTTP_PROTO', uri.protocol.replace(':', ''))
      .withEnv(
        'HTTP_UA',
        `${userAgent} (${this.pipeline.environment.name} v${this.pipeline.environment.version} ${this.pipeline.name})`
      );

    return of(
      new LambdaCronProxy(
        this.pipeline,
        this,
        cron.method,
        uri,
        HttpHeaders.from({
          Host: uri.host,
          'User-Agent': userAgent,
          [Rowdy.HEADERS.CRON]: cron.line,
        }),
        Buffer.alloc(0),
        { method: cron.method, uri, headers: {} }
      )
    );
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

export class LambdaCronProxy extends LambdaHttpProxy {
  @Trace
  override into(): Observable<Response<LambdaPipeline>> {
    return this.invoke().pipe(
      map((http) => {
        const response = new LambdaResponse(this.pipeline, this.request);
        const { cancel: cancelDeadline } = this.request.onDeadline(() => {
          log.warn('LambdaCronProxy Request Deadline Reached', { requestId: this.pipeline.requestId });
          response.error(new Error('Request deadline reached'));
          http.data.destroy(new Error('Request deadline reached'));
        });
        // Set to 0 bytes as the prelude is not counted
        response.next(new Chunk(JSON.stringify(http.prelude()), 0));
        response.next(new Chunk(Buffer.alloc(8), 0));
        http.data.on('data', (chunk: Buffer) => response.next(new Chunk(chunk, chunk.length)));
        // DEVNOTE: EventBridge Scheduler ignores the response payload, so a failed cron request is
        // only visible if the invocation itself fails. Erroring here marks it as a Lambda error.
        const settle = (): void =>
          cancelDeadline(() => {
            if (http.status >= 400) {
              log.warn('LambdaCronProxy Request Failed', { status: http.status, uri: this.uri.toString() });
              response.error(new Error(`Cron request to ${this.uri.toString()} failed with status ${http.status}`));
              return;
            }
            response.complete();
          });
        http.data.on('end', settle);
        http.data.on('close', settle);
        http.data.on('error', (error: Error) => cancelDeadline(() => response.error(error)));
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
    const result = new AsyncSubject<Result<LambdaPipeline>>();

    // eslint-disable-next-line no-restricted-globals
    const url = new URL(
      `http://${this.pipeline.runtimeApi}/2018-06-01/runtime/invocation/${this.pipeline.requestId}/response`
    );

    const req = http.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/vnd.awslambda.http-integration-response',
        'Lambda-Runtime-Function-Response-Mode': 'streaming',
        'Transfer-Encoding': 'chunked',
        Trailer: ['Lambda-Runtime-Function-Error-Type', 'Lambda-Runtime-Function-Error-Body'],
      },
      timeout: 0,
      signal: this.signal,
    });

    req.on('finish', () => {
      log.debug(`LambdaResponse HTTP Request Finished`, {
        requestId: this.pipeline.requestId,
        chunks: this.chunks,
        bytes: this.bytes,
      });
      result.next(new Result(this.pipeline, this.request, true, this.bytes));
    });

    req.on('close', () => {
      log.debug(`LambdaResponse HTTP Request Closed`, {
        requestId: this.pipeline.requestId,
        chunks: this.chunks,
        bytes: this.bytes,
      });
      result.complete();
    });

    req.on('error', (error) => {
      log.warn(`LambdaResponse HTTP Request Error`, {
        error: JSON.stringify(error),
        chunks: this.chunks,
        bytes: this.bytes,
      });
      result.next(new Result(this.pipeline, this.request, false, this.bytes));
      result.complete();
    });

    req.on('abort', () => {
      log.warn(`LambdaResponse HTTP Request Aborted`, {
        requestId: this.pipeline.requestId,
        chunks: this.chunks,
        bytes: this.bytes,
      });
      result.next(new Result(this.pipeline, this.request, false, this.bytes));
      result.complete();
    });

    req.on('timeout', () => {
      log.warn(`LambdaResponse HTTP Request Timed Out`, {
        requestId: this.pipeline.requestId,
        chunks: this.chunks,
        bytes: this.bytes,
      });
      result.next(new Result(this.pipeline, this.request, false, this.bytes));
      result.complete();
    });

    req.on('response', (res) => {
      log.debug(`LambdaResponse HTTP Response Received`, {
        requestId: this.pipeline.requestId,
        chunks: this.chunks,
        bytes: this.bytes,
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        headers: JSON.stringify(res.headers),
      });
      // Consume the response body to allow the socket to close properly
      res.resume();
    });

    req.on('information', (info) => {
      log.debug(`LambdaResponse HTTP Informational Response Received`, {
        requestId: this.pipeline.requestId,
        chunks: this.chunks,
        bytes: this.bytes,
        statusCode: info.statusCode,
        statusMessage: info.statusMessage,
        headers: JSON.stringify(info.headers),
      });
    });

    const subscription = this.subscribe({
      next: (chunk) => {
        log.debug(`LambdaResponse Chunk`, { responseBytes: chunk.bytes, length: chunk.data.length });
        this.bytes += chunk.bytes;
        if (!chunk.data.length) {
          return;
        }
        this.chunks += 1;
        req.write(chunk.data);
      },
      error: (error) => {
        log.warn(`LambdaResponse Error`, { error, chunks: this.chunks, responseBytes: this.bytes });
        if (!this.bytes) req.write('\r\n\r\n'); // empty body
        req.addTrailers({
          'Lambda-Runtime-Function-Error-Type': `Runtime.${error.name}`,
          'Lambda-Runtime-Function-Error-Body': Buffer.from(error.message).toString('base64'),
        });
        req.end();
      },
      complete: () => {
        log.debug(`LambdaResponse Complete`, { chunks: this.chunks, responseBytes: this.bytes });
        if (!this.bytes) req.write('\r\n\r\n'); // empty body
        req.end();
      },
    });

    return result.asObservable().pipe(tap(() => subscription.unsubscribe()));
  }

  override repr(): string {
    return `LambdaResponse(requestId=${this.pipeline.requestId}, chunks=${this.chunks}, bytes=${this.bytes})`;
  }
}
