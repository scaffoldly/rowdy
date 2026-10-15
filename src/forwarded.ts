import { URI } from './routes';

/** How a request reached the deployment, as the command's HTTP_* variables describe it. */
export type Reached = {
  host: string;
  hostname: string;
  port: string;
  proto: string;
};

/** Why forwarded values were or were not used. */
export type Trust = { trusted: true; origin: string } | { trusted: false; reason: string; origin?: string };

type Headers = Record<string, string | undefined>;

/** The port a scheme implies when its URL names none: `80` for http, `443` for https. */
export const defaultPort = (proto: string): string | undefined => ({ http: '80', https: '443' })[proto];

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

/** The port written in `host[:port]`, IPv6 literals included; undefined when there is none. */
export const portIn = (host: string): string | undefined => /^(?:\[[^\]]*\]|[^:]*):(\d+)$/.exec(host)?.[1];

const header = (headers: Headers, name: string): string | undefined => {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
};

// The client-most value of a header a proxy chain may have appended to.
const first = (value?: string): string | undefined => value?.split(',')[0]?.trim() || undefined;

// RFC 7239: a parameter of the first (client-most) element of `Forwarded`.
const forwarded = (headers: Headers, name: 'host' | 'proto'): string | undefined => {
  const element = first(header(headers, 'forwarded'));
  const pair = element
    ?.split(';')
    .map((p) => p.trim().split('='))
    .find(([k]) => k?.toLowerCase() === name);
  return pair?.[1]?.replace(/^"(.*)"$/, '$1') || undefined;
};

// Cloudflare: `CF-Visitor: {"scheme":"https"}`.
const cfVisitor = (headers: Headers): string | undefined => {
  const value = header(headers, 'cf-visitor');
  if (!value) {
    return undefined;
  }
  try {
    const { scheme } = JSON.parse(value) as { scheme?: unknown };
    return typeof scheme === 'string' ? scheme : undefined;
  } catch {
    return undefined;
  }
};

/** The host the client asked a proxy for: `Forwarded: host=`, else `X-Forwarded-Host`. */
export const forwardedHost = (headers: Headers): string | undefined =>
  forwarded(headers, 'host') || first(header(headers, 'x-forwarded-host'));

/**
 * The scheme the client used with a proxy. A CDN's own header describes the client's connection;
 * `X-Forwarded-Proto` can describe a later hop, such as the CDN's own connection to the Function URL.
 */
export const forwardedProto = (headers: Headers): string | undefined =>
  (
    first(header(headers, 'cloudfront-forwarded-proto')) ||
    cfVisitor(headers) ||
    forwarded(headers, 'proto') ||
    first(header(headers, 'x-forwarded-proto'))
  )?.toLowerCase();

/**
 * How a Function URL request reached the deployment. Forwarded values are anyone's to send, so
 * they are used only when the origin they make is one of `hosts`; otherwise the request is
 * described by its own `Host`, which Lambda requires to be the Function URL's, over https.
 */
export const reachedBy = (headers: Headers, hosts: readonly string[]): { reached: Reached; trust: Trust } => {
  const host = header(headers, 'host') || 'localhost';
  const own: Reached = { host, hostname: host, port: portIn(host) || '443', proto: 'https' };

  const hostname = forwardedHost(headers);
  if (!hostname) {
    return { reached: own, trust: { trusted: false, reason: 'no forwarded host' } };
  }
  const proto = forwardedProto(headers) || 'https';
  const origin = originOf(proto, hostname);
  if (!hosts.includes(origin)) {
    return { reached: own, trust: { trusted: false, reason: 'origin not in spec.hosts', origin } };
  }
  return {
    reached: { host, hostname, port: portIn(hostname) || defaultPort(proto) || '', proto },
    trust: { trusted: true, origin },
  };
};
