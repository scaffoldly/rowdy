import parseDataURL from 'data-urls';
import { match as pathMatch, compile as pathCompile, pathToRegexp } from 'path-to-regexp';
import { decode, labelToName } from 'whatwg-encoding';
import { log } from './log';

// Largely inspired by HTTPRoute in gateway.networking.k8s.io/v1
export type RouteRuleMatchDetail = {
  type?:
    | 'PathToRegexp' // DEVNOETE: added
    | 'RegularExpression'
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

export class Routes implements IRoutes {
  readonly version: RoutesVersion = 'v1alpaha1';
  readonly rules: Array<RouteRule> = [];

  withRules(rules: Array<RouteRule>): this {
    this.rules.push(...rules);
    return this;
  }

  withDefault(target: string): this {
    return this.withPath('{/*path}', `${target}*path`);
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

  intoDataURL(): string {
    const routes: IRoutes = { version: this.version, rules: this.rules };
    const mimeType = 'application/json';
    const json = JSON.stringify(routes);
    const base64 = Buffer.from(json, 'utf-8').toString('base64');
    return `data:${mimeType};base64,${base64}`;
  }

  intoURL(path: string): URL | undefined {
    const url = this.rules.reduce<URL | undefined>(
      (url, rule) =>
        rule.matches?.reduce<URL | undefined>((matched, match) => {
          if (matched) {
            return matched;
          }

          const { uri } = rule.backendRefs?.[0] || {}; // TODO: support weights
          const { type, value: pattern } = match.path || {};

          if (!type || !pattern || !uri) {
            return undefined;
          }

          try {
            if (!matched && type === 'Exact' && pattern === path) {
              matched = new URL(uri);
              matched.pathname = path;
            }

            if (!matched && type === 'PathPrefix' && path.startsWith(pattern)) {
              matched = new URL(uri);
              matched.pathname = path;
            }

            if (!matched && type === 'RegularExpression') {
              const regex = new RegExp(pattern);
              if (regex.test(path)) {
                matched = new URL(uri.replace(regex, pattern));
              }
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

              const compiled = pathCompile(new URL(uri).pathname)(match.params);
              matched = new URL(uri);
              matched.pathname = compiled;
            }
          } catch (e) {
            log.warn(`URI Compilation Failure: ${e instanceof Error ? e.message : String(e)}`, { uri });
          }

          return matched;
        }, url),
      undefined
    );

    return url;
  }
}
