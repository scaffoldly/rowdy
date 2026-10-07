export type CorsPolicy = {
  /** Origins allowed to read responses: `scheme://host[:port]`, `null`, or `*`. */
  origins: string[];
  /** Methods a preflight allows. Default `*`. */
  methods?: string[];
  /** Request headers a preflight allows. Default `*`. */
  headers?: string[];
  /** Response headers the browser exposes to the caller. Default none. */
  expose?: string[];
  /** Send `Access-Control-Allow-Credentials: true`. Default false. */
  credentials?: boolean;
  /** Seconds a browser may cache a preflight. Default unset (the browser's own default). */
  maxAge?: number;
};

/** `none` leaves CORS to the upstream; a policy has rowdy answer for the route. */
export type CorsSpec = 'none' | CorsPolicy;

/** Path pattern (path-to-regexp, as in `paths`) to CORS spec. The first matching pattern wins. */
export type CorsPaths = { [pattern: string]: CorsSpec };

type Headers = Record<string, string>;

const KEYS: ReadonlyArray<keyof CorsPolicy> = ['origins', 'methods', 'headers', 'expose', 'credentials', 'maxAge'];
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+$/;
const PREFLIGHT_VARY = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers';

const list = (pattern: string, key: string, value: unknown, fallback: string[]): string[] => {
  if (value === undefined) {
    return fallback;
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim().length)) {
    throw new Error(`CORS ${key} for '${pattern}' must be a list of strings`);
  }
  return value.map((v: string) => v.trim());
};

export class Cors {
  private constructor(
    readonly pattern: string,
    readonly spec: Required<Omit<CorsPolicy, 'maxAge'>> & Pick<CorsPolicy, 'maxAge'>
  ) {}

  /** The policy for `spec`, or undefined for `none`. Throws on anything else. */
  static parse(pattern: string, spec: unknown): Cors | undefined {
    if (spec === 'none') {
      return undefined;
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`Invalid CORS for '${pattern}', expected 'none' or a policy`);
    }

    const policy = spec as Record<string, unknown>;
    for (const key of Object.keys(policy)) {
      if (!(KEYS as ReadonlyArray<string>).includes(key)) {
        throw new Error(`Unknown CORS key '${key}' for '${pattern}', expected one of ${KEYS.join(', ')}`);
      }
    }

    if (policy.origins !== undefined && !Array.isArray(policy.origins)) {
      throw new Error(`CORS origins for '${pattern}' must be a list`);
    }
    const origins = list(pattern, 'origins', policy.origins, []).map((o) => o.toLowerCase().replace(/\/+$/, ''));
    if (!origins.length) {
      throw new Error(`CORS for '${pattern}' needs origins`);
    }
    for (const origin of origins) {
      if (origin !== '*' && origin !== 'null' && !ORIGIN.test(origin)) {
        throw new Error(`Invalid CORS origin '${origin}' for '${pattern}', expected scheme://host[:port], null, or *`);
      }
    }

    if (policy.credentials !== undefined && typeof policy.credentials !== 'boolean') {
      throw new Error(`CORS credentials for '${pattern}' must be true or false`);
    }

    const maxAge = policy.maxAge;
    if (maxAge !== undefined && (typeof maxAge !== 'number' || !Number.isInteger(maxAge) || maxAge < 0)) {
      throw new Error(`CORS maxAge for '${pattern}' must be a non-negative integer`);
    }

    return new Cors(pattern, {
      origins,
      methods: list(pattern, 'methods', policy.methods, ['*']).map((m) => m.toUpperCase()),
      headers: list(pattern, 'headers', policy.headers, ['*']).map((h) => h.toLowerCase()),
      expose: list(pattern, 'expose', policy.expose, []).map((h) => h.toLowerCase()),
      credentials: policy.credentials === true,
      ...(maxAge !== undefined ? { maxAge: maxAge as number } : {}),
    });
  }

  /**
   * The value of Access-Control-Allow-Origin for `origin`, if allowed. With credentials a `*`
   * policy echoes the origin, since browsers reject a literal `*` on a credentialed response.
   */
  private allowOrigin(origin: string | undefined): string | undefined {
    if (!origin) {
      return undefined;
    }
    const { origins, credentials } = this.spec;
    if (origins.includes(origin.toLowerCase())) {
      return origin;
    }
    if (origins.includes('*')) {
      return credentials ? origin : '*';
    }
    return undefined;
  }

  private allow(origin: string | undefined): Headers {
    const allowed = this.allowOrigin(origin);
    if (!allowed) {
      return {};
    }
    return {
      'access-control-allow-origin': allowed,
      ...(this.spec.credentials ? { 'access-control-allow-credentials': 'true' } : {}),
    };
  }

  /** The CORS headers for a preflight. A disallowed origin gets none, which the browser treats as a refusal. */
  preflight(origin: string | undefined, method: string | undefined, headers: string | undefined): Headers {
    const allowed = this.allow(origin);
    if (!allowed['access-control-allow-origin']) {
      return { vary: PREFLIGHT_VARY };
    }

    // Browsers take `*` literally on a credentialed request, so echo what was asked for instead.
    const { methods, headers: allowHeaders, credentials, maxAge } = this.spec;
    const allowMethods = methods.includes('*') ? (credentials ? method : '*') : methods.join(', ');
    const allowRequestHeaders = allowHeaders.includes('*') ? (credentials ? headers : '*') : allowHeaders.join(', ');

    return {
      ...allowed,
      ...(allowMethods ? { 'access-control-allow-methods': allowMethods } : {}),
      ...(allowRequestHeaders ? { 'access-control-allow-headers': allowRequestHeaders } : {}),
      ...(maxAge !== undefined ? { 'access-control-max-age': String(maxAge) } : {}),
      vary: PREFLIGHT_VARY,
    };
  }

  /** The CORS headers for an actual response. They replace any the upstream sent. */
  response(origin: string | undefined): Headers {
    const allowed = this.allow(origin);
    const { expose } = this.spec;
    return {
      ...allowed,
      ...(allowed['access-control-allow-origin'] && expose.length
        ? { 'access-control-expose-headers': expose.join(', ') }
        : {}),
      vary: 'Origin',
    };
  }
}
