import axios, { AxiosError, AxiosHeaders } from 'axios';
import { Subject } from 'rxjs';
import packageJson from '../../../package.json';
import { ImageApi } from '../../api/image';
import type { IApi, IImageApi } from '../../api/types';
import type { Event } from '../../events';
import type { Logger } from '../../log';
import type { AwsSandboxOptions } from '..';
import { authenticator } from '../../util/axios';

/**
 * What a sandbox needs of rowdy, without its CLI or runtimes, which a host like a Cloudflare Worker can't load. It
 * aborts alone, or when `signal` does.
 */
export class SandboxEnvironment implements IApi {
  readonly abort: AbortController = new AbortController();
  readonly signal: AbortSignal = this.abort.signal;
  /** Events from what isn't a compute's own, such as copying an image. */
  readonly event$ = new Subject<Event>();
  readonly http = axios.create();
  readonly images: IImageApi = new ImageApi(this);
  readonly name = packageJson.name;
  readonly version = packageJson.version;
  readonly registry: string | undefined = undefined;
  /** Milliseconds between checks on AWS, or undefined for each check's own default. */
  readonly pollInterval: number | undefined;
  /** What its AWS clients act as, or undefined for the AWS SDK's own chain. */
  readonly credentials: AwsSandboxOptions['credentials'];

  constructor(
    public readonly log: Logger,
    {
      signal,
      pollInterval,
      credentials,
    }: { signal?: AbortSignal; pollInterval?: number; credentials?: AwsSandboxOptions['credentials'] } = {}
  ) {
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

  /** Where the image API sends its events. */
  get environment(): this {
    return this;
  }

  get userAgent(): string {
    return `${this.name}@${this.version}`;
  }
}
