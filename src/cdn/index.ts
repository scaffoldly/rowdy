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

/** The headers of the CDN a request came through, else of a plain proxy. */
export const cdnHeaders = (headers: HeaderMap): CdnHeaders =>
  CloudFrontHeaders.from(headers) ?? CloudflareHeaders.from(headers) ?? ProxyHeaders.from(headers);

/**
 * How a Function URL request reached the deployment, as its headers tell it: the visitor's host and
 * scheme from the CDN or proxy in front, else the request's own `Host` over https.
 */
export const reachedBy = (headers: HeaderMap): { reached: Reached; cdn: string } => {
  const cdn = cdnHeaders(headers);
  const host = cdn.requestHost() || 'localhost';
  const hostname = cdn.host() || host;
  const proto = cdn.proto() || 'https';
  return {
    reached: { host, hostname, port: portIn(hostname) || defaultPort(proto) || '', proto },
    cdn: cdn.name,
  };
};
