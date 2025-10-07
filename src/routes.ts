import parseDataURL from 'data-urls';
import { match as pathMatch, compile as pathCompile, pathToRegexp } from 'path-to-regexp';
import { decode, labelToName } from 'whatwg-encoding';
import { ILoggable, log } from './log';
import { CheckResult, httpCheck, httpsCheck } from './util/http';

// Largely inspired by HTTPRoute in gateway.networking.k8s.io/v1
export type RouteRuleMatchDetail = {
  type?:
    | 'PathToRegexp' // DEVNOETE: added
    | 'Exact'
    | 'PathPrefix';

  value?: string;
};

export type RouteRuleMatch = {
  path?: RouteRuleMatchDetail;
};

export type RouteRuleBackendRef = {
  // name?: string; // DEVNOTE: removed, use 'uri' instead
  // port?: number; // DEVNOTE: removed, use 'uri' instead
  uri?: string; // DEVNOTE: added
  insecure?: boolean; // DEVNOTE: added
};

export type RouteRule = {
  matches?: Array<RouteRuleMatch>;
  backendRefs?: Array<RouteRuleBackendRef>;
};

export type RoutesVersion = 'v1alpaha1';

export interface IRoutes {
  readonly version: RoutesVersion;
  readonly rules: Array<RouteRule>;
}

export type URIHealth = { healthy: boolean; latency: CheckResult };

// eslint-disable-next-line no-restricted-globals
export class URI extends URL implements ILoggable {
  private constructor(
    // eslint-disable-next-line @typescript-eslint/no-restricted-types
    url: URL,
    public readonly insecure: boolean = false
  ) {
    super(url.toString());
  }

  static from(uri: string): URI {
    uri = uri.trim().toLowerCase();

    const insecure = uri.startsWith('insecure+');
    if (insecure) {
      uri = uri.replace('insecure+', '');
    }

    // Normalization
    if (uri === 'localhost') {
      uri = 'http://localhost';
    }

    // eslint-disable-next-line no-restricted-globals
    let url = new URL(uri);

    if (url.protocol === 'localhost:') {
      // eslint-disable-next-line no-restricted-globals
      url = new URL(`http://${uri}`);
    }

    if (url.protocol === 'http:' && url.port === '443') {
      url.protocol = 'https:';
      url.port = '';
    }

    if (url.protocol === 'aws:') {
      // eslint-disable-next-line no-restricted-globals
      url = new URL(`cloud://aws/${uri}`);
    }

    return new URI(url, insecure);
  }

  async health(): Promise<URIHealth> {
    const health: URIHealth = { healthy: false, latency: 'unknown' };

    if (this.protocol === 'rowdy:') {
      health.latency = '0.00ms';
    }

    if (this.protocol === 'cloud:') {
      health.healthy = true;
    }

    if (this.protocol === 'http:') {
      health.latency = await httpCheck(this.origin);
    }

    if (this.protocol === 'https:') {
      health.latency = await httpsCheck(this.origin);
    }

    health.healthy = health.healthy || (health.latency !== 'error' && health.latency !== 'timeout');
    return health;
  }

  repr(): string {
    return `URI(${this.toString()})`;
  }
}

export type Health = { [origin: string]: URIHealth };

export class Routes implements IRoutes, ILoggable {
  readonly version: RoutesVersion = 'v1alpaha1';
  readonly rules: Array<RouteRule> = [];

  static fromDataURL(dataUrl?: string): Routes {
    try {
      if (!dataUrl && !process.env.SLY_ROUTES) {
        return new Routes();
      }

      if (!dataUrl) {
        return Routes.fromDataURL(process.env.SLY_ROUTES);
      }

      const data = parseDataURL(dataUrl);
      if (!data) {
        throw new Error('Invalid data URL');
      }

      const encoding = labelToName(data.mimeType.parameters.get('charset') || 'utf-8');
      if (!encoding) {
        throw new Error(`Invalid encoding: ${data.mimeType.parameters.get('charset')}`);
      }

      const decoded = decode(data.body, encoding);
      if (data.mimeType.essence === 'application/json') {
        const routes: IRoutes = JSON.parse(decoded);
        if (routes.version !== 'v1alpaha1') {
          throw new Error(`Unsupported routes version: ${routes.version}`);
        }

        return new Routes().withRules(routes.rules);
      }

      throw new Error(`Invalid MIME type ${data.mimeType.essence}`);
    } catch (e) {
      log.warn(`Failed to load routes: ${e instanceof Error ? e.message : String(e)}`);
      return new Routes();
    }
  }

  withRules(rules: Array<RouteRule>): this {
    this.rules.push(...rules);
    return this;
  }

  withDefault(target: string): this {
    if (!target || target.trim() === '') {
      target = 'rowdy://health/';
    }
    return this.withPath('{/*path}', `${target}*path`);
  }

  withPaths(paths: { [key: string]: string | undefined }): this {
    Object.entries(paths).forEach(([path, target]) => {
      if (target) {
        this.withPath(path, target);
      }
    });
    return this;
  }

  withPath(path: string, target: string): this {
    return this.withMatch({ path: { type: 'PathToRegexp', value: path } }, { uri: target });
  }

  withMatch(match: RouteRuleMatch, target: RouteRuleBackendRef): this {
    let ix = this.rules.findIndex((r) => {
      if (!r.matches || r.matches.length === 0) {
        return false;
      }
      return JSON.stringify(r.matches[0]) === JSON.stringify(match);
    });

    if (ix === -1) {
      ix =
        this.rules.push({
          matches: [match],
          backendRefs: [],
        }) - 1;
    }

    this.rules[ix]?.backendRefs?.push(target);
    return this;
  }

  intoDataURL(): string {
    const routes: IRoutes = { version: this.version, rules: this.rules };
    const mimeType = 'application/json';
    const json = JSON.stringify(routes);
    const base64 = Buffer.from(json, 'utf-8').toString('base64');
    return `data:${mimeType};base64,${base64}`;
  }

  intoURI(path: string): URI | undefined {
    return this.rules.reduce<URI | undefined>(
      (uri, rule) =>
        rule.matches?.reduce<URI | undefined>((matched, match) => {
          if (matched) {
            return matched;
          }

          const { uri, insecure } = rule.backendRefs?.[0] || {}; // TODO: support weights
          const { type, value: pattern } = match.path || {};

          if (!type || !pattern || !uri) {
            return undefined;
          }

          try {
            if (!matched && type === 'Exact' && pattern === path) {
              matched = URI.from(uri);
              matched.pathname = path;
            }

            if (!matched && type === 'PathPrefix' && path.startsWith(pattern)) {
              matched = URI.from(uri);
              matched.pathname = path;
            }

            if (!matched && type === 'PathToRegexp') {
              const match = pathMatch(pattern)(path);

              if (!match) {
                return undefined;
              }

              const wildcard = pathToRegexp(pattern).keys.find((key) => key.type === 'wildcard')?.name;

              if (wildcard && !match.params[wildcard]) {
                match.params[wildcard] = [''];
              }

              const compiled = pathCompile(URI.from(uri).pathname)(match.params);
              matched = URI.from(uri);
              matched.pathname = compiled;
            }

            if (matched && insecure) {
              matched.protocol = `insecure+${matched.protocol}`;
            }
          } catch (e) {
            log.warn(`URI Compilation Failure: ${e instanceof Error ? e.message : String(e)}`, { uri });
          }

          return matched;
        }, uri),
      undefined
    );
  }

  async health(): Promise<Health> {
    return await this.rules
      .flatMap((rule) => rule.backendRefs ?? [])
      .map((ref) => ref.uri)
      .filter((uri): uri is string => !!uri)
      .map((uri) => URI.from(uri))
      .reduce(
        async (healthP, uri) => {
          const health = await healthP;
          const origin = uri.origin !== 'null' ? uri.origin : `${uri.protocol}//${uri.host}`;
          health[origin] = await uri.health();
          return health;
        },
        Promise.resolve({} as Health)
      );
  }

  repr(): string {
    return `Routes(version=${this.version}, rules=${JSON.stringify(this.rules)})`;
  }
}
