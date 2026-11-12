import axios, {
  AxiosInstance,
  AxiosError,
  AxiosResponse,
  InternalAxiosRequestConfig,
  AxiosHeaders,
  CanceledError,
} from 'axios';
import { Readable } from 'stream';
import ms from 'ms';
import { Observable, Subject } from 'rxjs';
import { parse } from 'auth-header';
import { Logger } from '../log';
import { HttpHeaders } from '../proxy/headers';
import { headers as awsHeaders } from '../aws/headers';
import type { AwsSandboxOptions } from '../sandbox';

const headers = async (
  log: Logger,
  scheme: string,
  // eslint-disable-next-line @typescript-eslint/no-restricted-types
  realm: URL,
  service: string,
  authorization?: string,
  credentials?: AwsSandboxOptions['credentials']
): Promise<HttpHeaders> => {
  // Dealing with AWS www-authenticate not being standard, apparently...
  if (service.endsWith('.amazonaws.com')) {
    return awsHeaders(log, scheme, realm, service, credentials);
  }

  log.debug(`Requesting ${scheme} token from ${realm.toString()}`, { service, authorization: !!authorization });

  const auth = await axios.get(realm.toString(), {
    headers: authorization ? { Authorization: authorization } : undefined,
  });

  log.debug(`Received ${scheme} token response`, { status: auth.status, statusText: auth.statusText });

  if (auth.status !== 200 || !auth.data?.token) {
    throw new AxiosError(`Failed to obtain token: ${auth.status} ${auth.statusText}`);
  }

  return HttpHeaders.from({ Authorization: `${scheme} ${auth.data.token}` });
};

type AxiosConfig = InternalAxiosRequestConfig & { _isRetry?: boolean };
type Authenticator = {
  request: [
    (config: InternalAxiosRequestConfig) => Promise<InternalAxiosRequestConfig>,
    (error: AxiosError) => Promise<InternalAxiosRequestConfig | never>,
  ];
  response: [
    (response: AxiosResponse) => Promise<AxiosResponse>,
    (error: AxiosError) => Promise<AxiosResponse | never>,
  ];
};

export function authenticator(
  axios: AxiosInstance,
  log: Logger,
  credentials?: AwsSandboxOptions['credentials']
): Authenticator {
  const preRequest = async (config: AxiosConfig): Promise<AxiosConfig> => {
    return config;
  };

  const preRequestError = async (error: AxiosError): Promise<InternalAxiosRequestConfig | never> => {
    throw error;
  };

  const responseSuccess = async (response: AxiosResponse): Promise<AxiosResponse> => {
    return response;
  };

  const responseError = async (error: AxiosError): Promise<AxiosResponse | never> => {
    const response = error.response;
    const request = error.response?.config as AxiosConfig;

    log.debug(`Intercepting HTTP ${error.status}: ${error.message}`, {
      url: request?.url,
      method: request?.method,
      isRetry: request?._isRetry,
      requestHeaders: JSON.stringify(request?.headers),
      responseHeaders: JSON.stringify(response?.headers),
    });

    if (!response) throw error;

    const authorization = request.headers?.get('authorization') as string | undefined;

    // Bail if we've already retried
    if (request._isRetry) throw error;
    request._isRetry = true;

    const wwwAuth = response.headers['www-authenticate'];
    if (!wwwAuth) {
      throw error;
    }

    const { scheme, params } = parse(wwwAuth);

    const { realm, service, scope } = params;

    log.debug(`Handling ${scheme} authentication challenge...`, { realm, service, scope });

    if (!realm || Array.isArray(realm) || !service || Array.isArray(service) || (!!scope && Array.isArray(scope))) {
      throw new AxiosError('Invalid WWW-Authenticate header');
    }

    // eslint-disable-next-line no-restricted-globals
    const url = new URL(realm);

    url.searchParams.append('service', service);
    if (scope) {
      url.searchParams.append('scope', scope);
    }

    const updated = await headers(log, scheme, url, service, authorization, credentials);

    request.headers = new AxiosHeaders(request.headers).concat(updated.intoAxios());
    return axios(request);
  };

  const auth: Authenticator = {
    request: [preRequest, preRequestError],
    response: [responseSuccess, responseError],
  };

  return auth;
}

declare module 'axios' {
  interface AxiosRequestConfig {
    /** Statuses retried beyond `RETRYABLE`, like a mirror's 404 for an image it hasn't cached yet. */
    alsoRetry?: number[];
  }
}

/** How a request that fails is tried again: `retries` more times, waiting twice as long each time, within bounds. */
export const RETRY = { retries: 6, minTimeout: 1_000, maxTimeout: 15_000 };
export const RETRYABLE: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** An axios instance that retries a retryable status, or one of the request's `alsoRetry`, waiting longer each time. */
/** Something an http instance says of its requests: `type` tells it apart, and `summary` is for reading. */
export type HttpEvent<Type extends string> = {
  type: Type;
  summary: string;
};

/** A registry answered 429. `wait` is the milliseconds until it's tried again, and `retryAfter` the registry's own. */
export type RateLimitedEvent = HttpEvent<'rate-limited'> & {
  wait: number;
  retryAfter?: string;
};

/** What an http instance says of its requests. */
export type HttpEvents = RateLimitedEvent;

/** An axios instance that retries what it can, saying so in `events()` when a registry rate-limits it. */
export type RowdyHttp = AxiosInstance & { events(): Observable<HttpEvents> };

export const RowdyHttp = {
  /**
   * `http`, retrying. It only retries what it can: anything else, like a 401 for auth or a redirect, goes on to the
   * interceptors after it, and a retry goes through them all again. Its requests end when `signal` aborts, waits for a
   * retry included.
   */
  from(http: AxiosInstance, signal?: AbortSignal): RowdyHttp {
    http.defaults.signal = signal;
    const event$ = new Subject<HttpEvents>();
    http.interceptors.response.use(undefined, async (error: AxiosError) => {
      const config = error.config as
        | (InternalAxiosRequestConfig & { attempt?: number; _isRetry?: boolean })
        | undefined;
      // A Cloudflare Worker's cap on outgoing requests holds for the rest of the request.
      if (!config || error.code === AxiosError.ERR_CANCELED || /too many subrequests/i.test(error.message)) throw error;
      // A connection lost before any response counts as a 500.
      const status = error.response?.status ?? 500;
      const attempt = config.attempt ?? 0;
      // A body that's a stream was spent by the attempt that failed.
      if (attempt >= RETRY.retries || config.data instanceof Readable) throw error;
      if (!RETRYABLE.has(status) && !config.alsoRetry?.includes(status)) throw error;

      (error.response?.data as { destroy?: () => void } | undefined)?.destroy?.();
      // A 429 says how long to wait in Retry-After, as seconds or an HTTP date.
      const header = status === 429 ? `${error.response?.headers?.['retry-after'] ?? ''}` : '';
      const after = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
      const wait = Number.isFinite(after)
        ? Math.max(0, after)
        : Math.min(RETRY.minTimeout * 2 ** attempt, RETRY.maxTimeout);
      if (status === 429) {
        const [, host = 'the registry', path = ''] = /^https?:\/\/([^/]+)([^?]*)/.exec(config.url ?? '') ?? [];
        const slug = path.replace(/^\/v2\//, '').replace(/\/(manifests|blobs)\/.*$/, '');
        const verb = ['get', 'head'].includes(config.method ?? 'get') ? 'pulling' : 'pushing';
        event$.next({
          type: 'rate-limited',
          summary: `Rate limited by ${host} ${verb} ${slug}, trying again in ${ms(wait, { long: true })}`,
          wait,
          ...(header ? { retryAfter: header } : {}),
        });
      }
      // A request aborted while it waits is cancelled then, as axios would cancel one in flight. Unref'd, so a wait
      // doesn't hold the process open once its request is given up on.
      await new Promise<void>((resolve, reject) => {
        const { signal } = config;
        const cancel = () => {
          clearTimeout(timer);
          reject(new CanceledError(undefined, undefined, config));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener?.('abort', cancel);
          resolve();
        }, wait);
        timer.unref?.();
        if (signal?.aborted) return cancel();
        signal?.addEventListener?.('abort', cancel);
      });
      // A new attempt can be challenged for auth again.
      return http.request({ ...config, attempt: attempt + 1, _isRetry: false } as InternalAxiosRequestConfig);
    });
    return Object.assign(http, { events: () => event$.asObservable() });
  },
};
