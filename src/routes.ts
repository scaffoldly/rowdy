import parseDataURL from 'data-urls';
import { match as pathMatch, compile as pathCompile, pathToRegexp } from 'path-to-regexp';
import { decode, labelToName } from 'whatwg-encoding';
import { ILoggable, log } from './log';
import { CheckResult, cloudCheck, httpCheck, httpsCheck, rowdyCheck } from './util/checks';
import { readFileSync } from 'fs';
import * as YAML from 'yaml';
import {
  catchError,
  defer,
  exhaustMap,
  filter,
  fromEvent,
  map,
  Observable,
  of,
  shareReplay,
  take,
  takeUntil,
  tap,
  timer,
} from 'rxjs';
import { ABORT } from '.';
import { ApiSchema, ApiVersion } from './api';

export type RoutePaths = { [key: string]: string | undefined };
export type RoutesSpec = { paths?: RoutePaths; default?: string };

export type RoutesSchema = ApiSchema<RoutesSpec, undefined>;

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

export interface IRoutes {
  readonly version: ApiVersion;
  readonly rules: Array<RouteRule>;
}

export type URIHealth = CheckResult;

type Search = { key: string; value: string } | URLSearchParams | string;

// eslint-disable-next-line no-restricted-globals
export class URI extends URL implements ILoggable {
  protected static awaits: Map<string, Observable<URI>> = new Map<string, Observable<URI>>();

  static ERROR = '__error__';

  protected constructor(
    // eslint-disable-next-line @typescript-eslint/no-restricted-types
    url: URL,
    public readonly insecure: boolean = false
  ) {
    super(url.toString());
  }

  get server(): string {
    return this.origin !== 'null' ? this.origin : this.href;
  }

  get error(): string | undefined {
    return this.searchParams.get(URI.ERROR) || undefined;
  }

  withSearch(search: Search, value?: string): this {
    const params = new URLSearchParams(this.search);

    if (typeof search === 'string') {
      const existing = search;
      const incoming = new URLSearchParams(search);
      search = new URLSearchParams(incoming.toString());
      if (value) {
        search.set(existing, value);
      }
    }

    if ('key' in search && 'value' in search) {
      const key = search.key;
      const value = search.value;
      search = new URLSearchParams();
      search.append(key, value);
    }

    for (const [key, value] of search) {
      params.append(key, value);
    }

    this.search = params.toString();
    return this;
  }

  static from(uri: string): URI {
    uri = uri.trim();

    const insecure = uri.startsWith('insecure+');
    if (insecure) {
      uri = uri.replace('insecure+', '');
    }

    // Normalization
    if (uri === 'localhost') {
      uri = 'http://localhost';
    }

    // eslint-disable-next-line @typescript-eslint/no-restricted-types
    let url: URL;

    try {
      // eslint-disable-next-line no-restricted-globals
      url = new URL(uri);
    } catch {
      url = URI.fromError(new Error(`Invalid URI: ${uri}`));
    }

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

    const built = new URI(url, insecure);

    return built;
  }

  static fromError(error: Error, code?: number): URI {
    return URI.from(`rowdy://error${code ? `:${code}` : ''}/`).withSearch(URI.ERROR, error.message);
  }

  async health(timeoutMs?: number): Promise<URIHealth> {
    if (this.protocol === 'rowdy:') {
      return rowdyCheck(this.href, this.error);
    }

    if (this.protocol === 'cloud:') {
      return cloudCheck(this.href, timeoutMs);
    }

    if (this.protocol === 'http:') {
      return httpCheck(this.origin, timeoutMs);
    }

    if (this.protocol === 'https:') {
      return httpsCheck(this.origin, timeoutMs);
    }

    return { status: 'unknown', reason: `Unsupported protocol: '${this.protocol}'` };
  }

  await(intervalMs = 1000): Observable<URI> {
    if (URI.awaits.has(this.toString())) {
      return URI.awaits.get(this.toString())!;
    }

    const check$ = defer(() => this.health(intervalMs)).pipe(
      map((h) => h.status === 'ok' || h.status === 'unknown'),
      catchError(() => of(false))
    );

    const await$ = timer(0, intervalMs).pipe(
      takeUntil(fromEvent(ABORT.signal, 'abort')),
      tap(() => log.debug(`Checking URI health`, { uri: this })),
      exhaustMap(() => check$),
      filter(Boolean),
      take(1),
      tap(() => log.info(`URI is healthy`, { uri: this })),
      map(() => this),
      shareReplay(1)
    );

    URI.awaits.set(this.toString(), await$);
    return await$;
  }

  repr(): string {
    return `URI(${this.toString()})`;
  }
}

export type Health = { [origin: string]: URIHealth };

export class Routes implements IRoutes, ILoggable {
  readonly version: ApiVersion = 'rowdy.run/v1alpha1';
  readonly rules: Array<RouteRule> = [];

  private constructor() {}

  static empty(): Routes {
    return new Routes()
      .withPath('/@rowdy/200', 'rowdy://http:200/')
      .withPath('/@rowdy/204', 'rowdy://http:204/')
      .withPath('/@rowdy/400', 'rowdy://http:400/')
      .withPath('/@rowdy/404', 'rowdy://http:401/')
      .withPath('/@rowdy/500', 'rowdy://http:500/')
      .withPath('/@rowdy/api{/*path}', 'rowdy://api/*path')
      .withPath('/@rowdy/health', 'rowdy://health/')
      .withPath('/@rowdy/ping', 'rowdy://ping/')
      .withPath('/@rowdy/routes', 'rowdy://routes/');
  }

  static default(): Routes {
    return Routes.empty().withDefault('');
  }

  static fromURL(url: string): Routes {
    if (url.startsWith('data:')) {
      return Routes.fromDataURL(url);
    }

    if (url.startsWith('file:')) {
      const path = url.replace(/^file:\/\//, '');
      return Routes.fromPath(path);
    }

    log.warn(`Unsupported Routes URL, defaulting to empty routes`, { url });

    return Routes.default();
  }

  static fromPath(path: string): Routes {
    log.debug(`Loading routes from path`, { path });
    try {
      const content = readFileSync(path, 'utf-8');
      log.debug(`Loaded routes from path`, { path, content });

      if (path.endsWith('.json')) {
        const routes: Partial<RoutesSchema> = JSON.parse(content);
        log.debug(`Parsed routes from JSON`, { path, routes: JSON.stringify(routes) });

        if (routes.apiVersion !== 'rowdy.run/v1alpha1') {
          throw new Error(`Unsupported routes version: ${routes.apiVersion}`);
        }

        if (routes.kind !== 'Routes') {
          throw new Error(`Unsupported routes kind: ${routes.kind}`);
        }

        return Routes.empty()
          .withPaths(routes.spec?.paths || {})
          .withDefault(routes.spec?.default || '');
      }

      if (path.endsWith('.yaml') || path.endsWith('.yml')) {
        const routes: Partial<RoutesSchema> = YAML.parse(content);
        log.debug(`Parsed routes from YAML`, { path, routes: JSON.stringify(routes) });

        if (routes.apiVersion !== 'rowdy.run/v1alpha1') {
          throw new Error(`Unsupported routes version: ${routes.apiVersion}`);
        }

        if (routes.kind !== 'Routes') {
          throw new Error(`Unsupported routes kind: ${routes.kind}`);
        }

        return Routes.empty()
          .withPaths(routes.spec?.paths || {})
          .withDefault(routes.spec?.default || '');
      }

      throw new Error(`Unsupported routes file type: ${path}`);
    } catch (e) {
      log.warn(
        `Failed to load routes from path: ${e instanceof Error ? e.message : String(e)}. Using default routes.`,
        {
          path,
        }
      );
      return Routes.default();
    }
  }

  static fromDataURL(dataUrl: string): Routes {
    try {
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
        const routes: RoutesSchema = JSON.parse(decoded);
        if (routes.apiVersion !== 'rowdy.run/v1alpha1') {
          throw new Error(`Unsupported routes version: ${routes.apiVersion}`);
        }

        if (routes.kind !== 'Routes') {
          throw new Error(`Unsupported routes kind: ${routes.kind}`);
        }

        return new Routes().withPaths(routes.spec?.paths || {}).withDefault(routes.spec?.default || '');
      }

      throw new Error(`Invalid MIME type ${data.mimeType.essence}`);
    } catch (e) {
      log.warn(`Failed to load routes: ${e instanceof Error ? e.message : String(e)}. Using default routes.`, {
        dataUrl,
      });
      return Routes.default();
    }
  }

  withDefault(target: string): this {
    if (!target || target.trim() === '') {
      target = 'rowdy://http:404/';
    }
    if (!target.endsWith('/')) {
      target = `${target}/`;
    }
    return this.withPath('{/*path}', `${target}*path`);
  }

  withPaths(paths: RoutePaths): this {
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
    const routes: RoutesSchema = {
      apiVersion: this.version,
      kind: 'Routes',
      spec: {
        paths: this.intoPaths(),
        default: this.intoDefault(),
      },
      status: undefined,
    };
    const mimeType = 'application/json';
    const json = JSON.stringify(routes);
    const base64 = Buffer.from(json, 'utf-8').toString('base64');
    return `data:${mimeType};base64,${base64}`;
  }

  intoDefault(): string {
    const def = this.rules.find((rule) => rule.matches?.[0]?.path?.value === '{/*path}');
    return (def?.backendRefs?.[0]?.uri || '').replace('*path', '');
  }

  intoPaths(): RoutePaths {
    return this.rules.reduce<RoutePaths>((paths, rule) => {
      // filter out the default
      if (rule.matches?.[0]?.path?.value === '{/*path}') {
        return paths;
      }

      const match = rule.matches?.[0];
      // TODO: support weights
      // TODO: support mutltiple
      const target = rule.backendRefs?.[0]?.uri;

      // TODO: support other match types
      if (match?.path?.type === 'PathToRegexp' && match.path.value && target) {
        paths[match.path.value] = target;
      }

      return paths;
    }, {});
  }

  intoURI(path: string): URI {
    const input = URI.from(`no://thing${path}`);

    // normalize path
    path = input.pathname;

    // preserve search and hash
    const { search, hash } = input;

    let uri = this.rules.reduce<URI | undefined>(
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

    if (!uri) {
      uri = URI.fromError(new Error(`Not Found: ${path}`), 404);
    }
    uri.search = search;
    uri.hash = hash;

    return uri;
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
          health[uri.server] = health[uri.server] || (await uri.health());
          return health;
        },
        Promise.resolve({} as Health)
      );
  }

  repr(): string {
    return `Routes(version=${this.version}, rules=${JSON.stringify(this.rules)})`;
  }
}
