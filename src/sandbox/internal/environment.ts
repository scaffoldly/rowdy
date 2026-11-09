import axios from 'axios';
import { Subject } from 'rxjs';
import packageJson from '../../../package.json';
import { ImageApi } from '../../api/image';
import type { IApi, IImageApi } from '../../api/types';
import type { Event } from '../../events';
import type { Logger } from '../../log';
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

  constructor(
    public readonly log: Logger,
    { signal, pollInterval }: { signal?: AbortSignal; pollInterval?: number } = {}
  ) {
    this.pollInterval = pollInterval;
    if (signal?.aborted) {
      this.abort.abort(signal.reason);
    }
    signal?.addEventListener('abort', () => this.abort.abort(signal.reason), { once: true });

    const auth = authenticator(this.http, this.log);
    this.http.interceptors.request.use(...auth.request);
    this.http.interceptors.response.use(...auth.response);
  }

  /** Where the image API sends its events. */
  get environment(): this {
    return this;
  }

  get userAgent(): string {
    return `${this.name}@${this.version}`;
  }
}
