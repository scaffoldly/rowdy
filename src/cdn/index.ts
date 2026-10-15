import { CloudflareHeaders } from './cloudflare/headers';
import { CloudFrontHeaders } from './cloudfront/headers';
import { CdnHeaders, defaultPort, HeaderMap, originOf, portIn, ProxyHeaders } from './headers';

export { CdnHeaders, CloudflareHeaders, CloudFrontHeaders, defaultPort, originOf, portIn, ProxyHeaders };
export type { HeaderMap };

/** How a request reached the deployment, as the command's HTTP_* variables describe it. */
export type Reached = {
  host: string;
  hostname: string;
  port: string;
  proto: string;
};

/** Why forwarded values were or were not used. */
export type Trust = { cdn: string } & (
  | { trusted: true; origin: string }
  | { trusted: false; reason: string; origin?: string }
);

/** The headers of the CDN a request came through, else of a plain proxy. */
export const cdnHeaders = (headers: HeaderMap): CdnHeaders =>
  CloudFrontHeaders.from(headers) ?? CloudflareHeaders.from(headers) ?? ProxyHeaders.from(headers);

/**
 * How a Function URL request reached the deployment. Forwarded values are anyone's to send, so
 * they are used only when the origin they make is one of `hosts`; otherwise the request is
 * described by its own `Host`, which Lambda requires to be the Function URL's, over https.
 */
export const reachedBy = (headers: HeaderMap, hosts: readonly string[]): { reached: Reached; trust: Trust } => {
  const cdn = cdnHeaders(headers);
  const host = cdn.requestHost() || 'localhost';
  const own: Reached = { host, hostname: host, port: portIn(host) || '443', proto: 'https' };

  const hostname = cdn.host();
  if (!hostname) {
    return { reached: own, trust: { cdn: cdn.name, trusted: false, reason: 'no forwarded host' } };
  }
  const proto = cdn.proto() || 'https';
  const origin = originOf(proto, hostname);
  if (!hosts.includes(origin)) {
    return { reached: own, trust: { cdn: cdn.name, trusted: false, reason: 'origin not in spec.hosts', origin } };
  }
  return {
    reached: { host, hostname, port: portIn(hostname) || defaultPort(proto) || '', proto },
    trust: { cdn: cdn.name, trusted: true, origin },
  };
};
