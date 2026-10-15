import { URI } from '../routes';

export type HeaderMap = Record<string, string | undefined>;

/** The port a scheme implies when its URL names none: `80` for http, `443` for https. */
export const defaultPort = (proto: string): string | undefined => ({ http: '80', https: '443' })[proto];

/** The port written in `host[:port]`, IPv6 literals included; undefined when there is none. */
export const portIn = (host: string): string | undefined => /^(?:\[[^\]]*\]|[^:]*):(\d+)$/.exec(host)?.[1];

/** `<proto>://<hostname>[:<port>]`, the port left out when it is the scheme's default; a port in `hostname` wins over `port`. */
export const originOf = (proto: string, hostname: string, port?: string): string => {
  const uri = URI.from(`${proto}://${hostname}`);
  if (uri.error || uri.origin === 'null') {
    return `${proto}://${hostname}`;
  }
  if (!portIn(hostname) && port) {
    uri.port = port;
  }
  return uri.origin;
};

/**
 * What a request's headers say about how the visitor reached the proxy in front of the Function
 * URL. Anyone can send these headers; callers decide whether to believe them.
 */
export abstract class CdnHeaders {
  protected constructor(protected readonly headers: HeaderMap) {}

  abstract get name(): string;

  /** The request's own `Host`: on a Function URL, always the Function URL's domain. */
  requestHost(): string | undefined {
    return this.get('host');
  }

  /** The host the visitor asked for: `Forwarded: host=`, else `X-Forwarded-Host`. */
  host(): string | undefined {
    return this.forwarded('host') || this.first('x-forwarded-host');
  }

  /** The scheme the visitor used: `Forwarded: proto=`, else `X-Forwarded-Proto`. */
  proto(): string | undefined {
    return (this.forwarded('proto') || this.first('x-forwarded-proto'))?.toLowerCase();
  }

  protected has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  protected get(name: string): string | undefined {
    const key = Object.keys(this.headers).find((k) => k.toLowerCase() === name);
    return key === undefined ? undefined : this.headers[key];
  }

  // The client-most value of a header a proxy chain may have appended to.
  protected first(name: string): string | undefined {
    return this.get(name)?.split(',')[0]?.trim() || undefined;
  }

  // RFC 7239: a parameter of the first (client-most) element of `Forwarded`.
  protected forwarded(param: 'host' | 'proto'): string | undefined {
    const pair = this.first('forwarded')
      ?.split(';')
      .map((p) => p.trim().split('='))
      .find(([k]) => k?.toLowerCase() === param);
    return pair?.[1]?.replace(/^"(.*)"$/, '$1') || undefined;
  }
}

/** A proxy that sends only the standard headers: RFC 7239 `Forwarded` and `X-Forwarded-*`. */
export class ProxyHeaders extends CdnHeaders {
  static from(headers: HeaderMap): ProxyHeaders {
    return new ProxyHeaders(headers);
  }

  get name(): string {
    return 'proxy';
  }
}
