import { CloudflareHeaders } from './cloudflare/headers';
import { CloudFrontHeaders } from './cloudfront/headers';
import { CloudFrontStore } from './cloudfront/store';
import { CdnHeaders, defaultPort, HeaderMap, originOf, portIn, ProxyHeaders } from './headers';
import { CdnStore, Written } from './store';

export {
  CdnHeaders,
  CdnStore,
  CloudflareHeaders,
  CloudFrontHeaders,
  CloudFrontStore,
  defaultPort,
  originOf,
  portIn,
  ProxyHeaders,
};
export type { HeaderMap, Written };

/** How a request reached the deployment, as the command's HTTP_* variables describe it. */
export type Reached = {
  host: string;
  hostname: string;
  port: string;
  proto: string;
};

/**
 * What became of a request's forwarded values: `listed` and `unchecked` were used, `unlisted` and
 * `absent` were not.
 */
export type Decision = 'listed' | 'unchecked' | 'unlisted' | 'absent';

export type Trust = { cdn: string; decision: Decision; origin?: string };

/** The headers of the CDN a request came through, else of a plain proxy. */
export const cdnHeaders = (headers: HeaderMap): CdnHeaders =>
  CloudFrontHeaders.from(headers) ?? CloudflareHeaders.from(headers) ?? ProxyHeaders.from(headers);

/** The store a `spec.hosts` value names; throws when no CDN recognizes it. */
export const cdnStore = (target: string): CdnStore => {
  const store = CloudFrontStore.from(target);
  if (!store) {
    throw new Error(
      `Invalid host target '${target}', expected a CloudFront KeyValueStore ARN such as arn:aws:cloudfront::123456789012:key-value-store/<id>`
    );
  }
  return store;
};

/**
 * How a Function URL request reached the deployment. Forwarded values are anyone's to send: with
 * `hosts`, they are used only when the origin they make is listed; without, they are used
 * unchecked. Unused, the request is described by its own `Host`, which Lambda requires to be the
 * Function URL's, over https.
 */
export const reachedBy = (headers: HeaderMap, hosts: readonly string[]): { reached: Reached; trust: Trust } => {
  const cdn = cdnHeaders(headers);
  const host = cdn.requestHost() || 'localhost';
  const own: Reached = { host, hostname: host, port: portIn(host) || '443', proto: 'https' };

  const hostname = cdn.host();
  if (!hostname) {
    return { reached: own, trust: { cdn: cdn.name, decision: 'absent' } };
  }
  const proto = cdn.proto() || 'https';
  const origin = originOf(proto, hostname);
  if (hosts.length && !hosts.includes(origin)) {
    return { reached: own, trust: { cdn: cdn.name, decision: 'unlisted', origin } };
  }
  return {
    reached: { host, hostname, port: portIn(hostname) || defaultPort(proto) || '', proto },
    trust: { cdn: cdn.name, decision: hosts.length ? 'listed' : 'unchecked', origin },
  };
};
