import axios, { AxiosError, AxiosHeaders } from 'axios';
import packageJson from '../../../package.json';
import { ImageApi } from '../../api/image';
import type { IApi, IImageApi } from '../../api/types';
import { Logger, type CdkOptions, type Sink } from '../../log';
import type { AwsSandboxOptions } from '..';
import { authenticator, RowdyHttp } from '../../util/axios';

// A host's stdout is its own. A Worker without `process` logs to its console.
const DEFAULT_SINK: Exclude<Sink, 'stderr'> = globalThis.process?.stderr ?? console;

/**
 * What a sandbox needs of rowdy, without its CLI or runtimes, which a host like a Cloudflare Worker can't load. It
 * aborts alone, or when `signal` does.
 */
export class SandboxEnvironment implements IApi {
  readonly abort: AbortController = new AbortController();
  readonly signal: AbortSignal = this.abort.signal;
  /** Its `loggerProvider`'s logger for rowdy, `'stderr'` included, or else process.stderr, at its `logLevel`. */
  readonly log: Logger;
  readonly http: RowdyHttp;
  readonly images: IImageApi = new ImageApi(this);
  readonly name = packageJson.name;
  readonly version = packageJson.version;
  readonly registry: string | undefined = undefined;
  /** Milliseconds between checks on AWS, or undefined for each check's own default. */
  readonly pollInterval: number | undefined;
  /** What its AWS clients act as, or undefined for the AWS SDK's own chain. */
  readonly credentials: AwsSandboxOptions['credentials'];

  constructor({
    signal,
    pollInterval,
    credentials,
    loggerProvider,
    logLevel,
  }: Pick<CdkOptions, 'loggerProvider' | 'logLevel'> & {
    signal?: AbortSignal;
    pollInterval?: number;
    credentials?: AwsSandboxOptions['credentials'];
  } = {}) {
    // Without a logLevel, the process-wide level, as @Trace's: info unless ROWDY_LOG_LEVEL, ROWDY_DEBUG or ROWDY_TRACE.
    const provider = loggerProvider === 'stderr' ? Logger.to('stderr', logLevel) : loggerProvider;
    this.log = new Logger('sandbox', provider?.getLogger(this.name, this.version) ?? DEFAULT_SINK, logLevel);
    this.http = RowdyHttp.from(axios.create(), this.signal, this.log);
    this.pollInterval = pollInterval;
    this.credentials = credentials;
    if (signal?.aborted) {
      this.abort.abort(signal.reason);
    }
    signal?.addEventListener('abort', () => this.abort.abort(signal.reason), { once: true });

    const auth = authenticator(this.http, this.log, this.credentials);
    this.http.interceptors.request.use(...auth.request);
    this.http.interceptors.response.use(...auth.response);

    // follow-redirects breaks on a Cloudflare Worker's node:http, so redirects are followed here.
    this.http.defaults.maxRedirects = 0;
    this.http.interceptors.response.use(undefined, (error: AxiosError) => {
      const { config, response } = error;
      const location = response?.headers?.location as string | undefined;
      const redirects = ((config as { redirects?: number } | undefined)?.redirects ?? 0) + 1;
      if (!config?.url || !response || !location || ![301, 302, 303, 307, 308].includes(response.status)) throw error;
      if (redirects > 5) throw error;
      (response.data as { destroy?: () => void } | undefined)?.destroy?.();

      // eslint-disable-next-line no-restricted-globals
      const [from, to] = [new URL(config.url), new URL(location, config.url)];
      const headers = new AxiosHeaders(config.headers);
      // A registry's token is for the registry, and a blob store refuses a second kind of auth.
      if (to.origin !== from.origin) headers.delete('Authorization');

      return this.http.request({
        ...config,
        url: to.href,
        headers,
        redirects,
        ...(response.status === 303 ? { method: 'get', data: undefined } : {}),
      } as typeof config);
    });
  }

  /** Where the image API logs, and what credentials its registry uses. */
  get environment(): this {
    return this;
  }

  get userAgent(): string {
    return `${this.name}@${this.version}`;
  }
}
