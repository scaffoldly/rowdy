import { Routes } from '@src';

describe('routes', () => {
  it('should accept string', () => {
    const routes = new Routes().with('http://example.com');
    const url = routes.intoURL('/test');
    expect(url?.toString()).toBe('http://example.com/test');
  });

  describe('Map-based routes configuration', () => {
    it('should handle single string route target', () => {
      const routeMap = new Map([['/api', 'http://api.example.com']]);
      const routes = new Routes().with(routeMap);
      const url = routes.intoURL('/api');
      expect(url?.toString()).toBe('http://api.example.com/api');
    });

    it('should handle multiple route patterns', () => {
      const routeMap = new Map([
        ['/api', 'http://api.example.com'],
        ['/static', 'http://cdn.example.com'],
      ]);
      const routes = new Routes().with(routeMap);

      const apiUrl = routes.intoURL('/api');
      expect(apiUrl?.toString()).toBe('http://api.example.com/api');

      const staticUrl = routes.intoURL('/static');
      expect(staticUrl?.toString()).toBe('http://cdn.example.com/static');
    });

    it('should handle exact path matches', () => {
      const routeMap = new Map([['/health', 'http://health.example.com']]);
      const routes = new Routes().with(routeMap);
      const url = routes.intoURL('/health');
      expect(url?.toString()).toBe('http://health.example.com/health');
    });
  });

  describe('Array of route targets', () => {
    it('should handle array of string targets', () => {
      const routeMap = new Map([
        ['/api', ['http://api1.example.com', 'http://api2.example.com']],
      ]);
      const routes = new Routes().with(routeMap);
      const url = routes.intoURL('/api');
      expect(url?.toString()).toBe('http://api1.example.com/api');
    });

    it('should handle array of target objects', () => {
      const routeMap = new Map([
        [
          '/api',
          [
            { target: 'http://api1.example.com', weight: 10 },
            { target: 'http://api2.example.com', weight: 5 },
          ],
        ],
      ]);
      const routes = new Routes().with(routeMap);
      const url = routes.intoURL('/api');
      expect(url?.toString()).toBe('http://api1.example.com/api');
    });

    it('should handle empty arrays gracefully', () => {
      const routeMap = new Map([['/api', []]]);
      const routes = new Routes().with(routeMap);
      const url = routes.intoURL('/api');
      expect(url).toBeUndefined();
    });
  });

  describe('Route pattern matching', () => {
    it('should match wildcard patterns', () => {
      const routeMap = new Map([['/users/:id', 'http://users.example.com']]);
      const routes = new Routes().with(routeMap);
      const url = routes.intoURL('/users/123');
      expect(url?.toString()).toBe('http://users.example.com/users/123');
    });

    it('should return undefined for non-matching paths', () => {
      const routeMap = new Map([['/api', 'http://api.example.com']]);
      const routes = new Routes().with(routeMap);
      const url = routes.intoURL('/dashboard');
      expect(url).toBeUndefined();
    });

    it('should match first route when multiple routes match', () => {
      const routeMap = new Map([
        ['/api', 'http://api.example.com'],
        ['/api', 'http://api2.example.com'],
      ]);
      const routes = new Routes().with(routeMap);
      const url = routes.intoURL('/api');
      expect(url?.toString()).toBe('http://api2.example.com/api');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty route map', () => {
      const routeMap = new Map();
      const routes = new Routes().with(routeMap);
      const url = routes.intoURL('/test');
      expect(url).toBeUndefined();
    });

    it('should preserve query parameters and fragments in original path', () => {
      const routes = new Routes().with('http://example.com');
      const url = routes.intoURL('/test?query=value#fragment');
      expect(url?.toString()).toBe(
        'http://example.com/test%3Fquery=value%23fragment'
      );
    });

    it('should handle root path', () => {
      const routes = new Routes().with('http://example.com');
      const url = routes.intoURL('/');
      expect(url?.toString()).toBe('http://example.com/');
    });

    it('should handle paths without leading slash', () => {
      const routes = new Routes().with('http://example.com');
      const url = routes.intoURL('test');
      expect(url?.toString()).toBe('http://example.com/test');
    });

    it('should handle target URLs with existing paths', () => {
      const routeMap = new Map([['/api', 'http://example.com/v1']]);
      const routes = new Routes().with(routeMap);
      const url = routes.intoURL('/api');
      expect(url?.toString()).toBe('http://example.com/api');
    });

    it('should handle routes with empty target arrays', () => {
      const routeMap = new Map([['/api', []]]);
      const routes = new Routes().with(routeMap);
      const url = routes.intoURL('/api');
      expect(url).toBeUndefined();
    });
  });
});
