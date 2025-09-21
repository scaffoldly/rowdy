import { pathToRegexp } from 'path-to-regexp';

type TRouteTarget = { target: string; weight?: number };
type TRoute = string | string[] | TRouteTarget | TRouteTarget[];
type TRouteMap<K, V> = Map<K, V>;
export type TRoutes = string | TRouteMap<string, TRoute>;

export class Routes {
  // TODO: support weights/priorities/hostnames/etc
  private routes: TRouteMap<RegExp, TRouteTarget[]> = new Map();

  with(routes: TRoutes): this {
    if (typeof routes === 'string') {
      this.routes.set(/.*/, [{ target: routes }]);
    } else {
      routes.forEach((route, key) => {
        if (typeof route === 'string') {
          this.routes.set(pathToRegexp(key).regexp, [{ target: route }]);
        } else if (Array.isArray(route)) {
          const targets: TRouteTarget[] = [];
          route.forEach((r) => {
            if (typeof r === 'string') {
              targets.push({ target: r });
            } else {
              targets.push(r);
            }
          });
          this.routes.set(pathToRegexp(key).regexp, targets);
          return;
        }
      });
    }
    return this;
  }

  // TODO: support templating
  intoURL(path: string): URL | undefined {
    for (const [pattern, targets] of this.routes) {
      if (!pattern.test(path)) {
        continue;
      }
      const target = targets[0]; // TODO: support weights/priorities
      if (!target) {
        continue;
      }
      const url = new URL(target.target);
      url.pathname = path;
      return url;
    }

    return undefined;
  }
}
