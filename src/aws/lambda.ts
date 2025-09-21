import {
  combineLatest,
  defer,
  from,
  map,
  mergeMap,
  NEVER,
  Observable,
  of,
  race,
} from 'rxjs';
import { Environment, Secrets } from '../environment';
import axios, { AxiosResponse } from 'axios';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { log } from '../log';
import { Request } from '../request';
import { Response } from '../response';
import { HttpProxy } from '../proxy/http';
import { ShellProxy } from '../proxy/shell';
import { Routes } from '../routes';

export class LambdaRequest extends Request {
  protected constructor(
    public readonly routes: Routes,
    public readonly runtimeApi: string,
    public readonly requestId: string,
    public readonly deadline: number,
    public readonly data: string,
    signal: AbortSignal
  ) {
    super(signal);
  }

  static from(
    routes: Routes,
    runtimeApi: string,
    payload: AxiosResponse<string>,
    signal: AbortSignal
  ): Request {
    const requestId = payload.headers['lambda-runtime-aws-request-id'];
    const deadline = payload.headers['lambda-runtime-deadline-ms'];

    return new LambdaRequest(
      routes,
      runtimeApi,
      requestId,
      deadline,
      payload.data,
      signal
    );
  }

  override into(): Observable<Response> {
    return new Observable<Response>((subscriber) => {
      const subscription = race(
        HttpProxy.fromLambda(this.routes, this.data, this.signal),
        ShellProxy.fromLambda(this.data, this.signal)
      )
        .pipe(
          mergeMap((p) => p.send()),
          map(
            (response) =>
              new LambdaResponse(
                this.runtimeApi,
                this.requestId,
                response,
                this.signal
              )
          )
        )
        .subscribe(subscriber);

      return () => {
        subscription.unsubscribe();
      };
    });
  }
}

export class LambdaResponse extends Response {
  constructor(
    protected runtimeApi: string,
    protected requestId: string,
    response: Response,
    signal: AbortSignal
  ) {
    super(signal);
    this.data.write(JSON.stringify(response.prelude));
    this.data.write(Buffer.alloc(8));
    response.data.pipe(this.data);

    response.data.on('end', () => {
      this.data.write('\r\n');
      this.data.end();
    });
  }

  override send(): Observable<this> {
    return from(
      axios.post(
        `http://${this.runtimeApi}/2018-06-01/runtime/invocation/${this.requestId}/response`,
        this.data,
        {
          headers: {
            'Content-Type':
              'application/vnd.awslambda.http-integration-response',
            'Lambda-Runtime-Function-Response-Mode': 'streaming',
            'Transfer-Encoding': 'chunked',
            Trailer: [
              'Lambda-Runtime-Function-Error-Type',
              'Lambda-Runtime-Function-Error-Body',
            ],
          },
          maxBodyLength: 20 * 1024 * 1024,
          signal: this.signal,
        }
      )
    ).pipe(
      map((_response) => {
        return this;
      })
    );
  }
}

export class LambdaEnvironment extends Environment {
  constructor(private runtimeApi: string) {
    super();
  }

  public override next(): Observable<Request> {
    const next$ = defer(() =>
      axios.get<string>(
        `http://${this.runtimeApi}/2018-06-01/runtime/invocation/next`,
        {
          responseType: 'text',
          signal: this.signal,
          timeout: 0,
        }
      )
    ).pipe(
      map((response) =>
        LambdaRequest.from(this.routes, this.runtimeApi, response, this.signal)
      )
    );

    return next$;
  }

  static _create(): Observable<Environment> {
    const runtimeApi = process.env.AWS_LAMBDA_RUNTIME_API;
    const routes = process.env.SLY_ROUTES;
    const secret = process.env.SLY_SECRET;

    if (!runtimeApi) {
      return NEVER;
    }

    let secrets: Observable<Secrets> = of({});

    if (secret) {
      secrets = from(
        new SecretsManagerClient().send(
          new GetSecretValueCommand({ SecretId: secret })
        )
      ).pipe(
        map((output) => {
          if (output.SecretString) {
            return JSON.parse(output.SecretString) as Secrets;
          }
          if (output.SecretBinary) {
            return JSON.parse(
              Buffer.from(output.SecretBinary).toString('utf-8')
            ) as Secrets;
          }
          log.warn(`Secret ${secret} has no SecretString or SecretBinary`);
          return {};
        })
      );
    }

    return combineLatest([of(routes), secrets]).pipe(
      map(([routes, secrets]) => {
        const env = new LambdaEnvironment(runtimeApi)
          .withRoutes(routes)
          .withSecrets(secrets);

        return env;
      })
    );
  }
}
