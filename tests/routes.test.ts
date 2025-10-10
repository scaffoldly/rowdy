import { Routes, URI } from '@src';

describe('routes', () => {
  describe('default', () => {
    it('should handle default', () => {
      const routes = Routes.default();
      expect(routes.rules).toHaveLength(3);
      expect(routes.intoURI('')!.toString()).toBe('rowdy://http:404/');
      expect(routes.intoURI('/foo/bar')!.toString()).toBe('rowdy://http:404/foo/bar');
      expect(routes.intoURI('/foo/bar?q=1')!.toString()).toBe('rowdy://http:404/foo/bar?q=1');
      expect(routes.intoURI('/_health')!.toString()).toBe('rowdy://health/');
      expect(routes.intoURI('/_health/baz')!.toString()).toBe('rowdy://http:404/_health/baz');
      expect(routes.intoURI('/_ping')!.toString()).toBe('rowdy://ping/');
      expect(routes.intoURI('/_ping/baz')!.toString()).toBe('rowdy://http:404/_ping/baz');
    });
  });

  describe('path chaining', () => {
    const data = Routes.empty()
      .withPath('/github', 'https://www.githubstatus.com/api/v2/status.json')
      .withPath('/circleci', 'https://status.circleci.com/api/v2/status.json')
      .withPath('/travisci', 'https://www.traviscistatus.com/api/v2/status.json')
      .withDefault('http://localhost:8080/api')
      .intoDataURL();

    it('should route', () => {
      const routes = Routes.fromDataURL(data);
      expect(routes.rules).toHaveLength(4);
      expect(routes.intoURI('/github')!.toString()).toBe('https://www.githubstatus.com/api/v2/status.json');
      expect(routes.intoURI('/circleci')!.toString()).toBe('https://status.circleci.com/api/v2/status.json');
      expect(routes.intoURI('/travisci')!.toString()).toBe('https://www.traviscistatus.com/api/v2/status.json');
      expect(routes.intoURI('/unknown')!.toString()).toBe('http://localhost:8080/api/unknown');
      expect(routes.intoURI('/unknown/')!.toString()).toBe('http://localhost:8080/api/unknown/');
      expect(routes.intoURI('/also/unknown')!.toString()).toBe('http://localhost:8080/api/also/unknown');
      expect(routes.intoURI('/')!.toString()).toBe('http://localhost:8080/api/');
      expect(routes.intoURI('')!.toString()).toBe('http://localhost:8080/api/');
    });

    it('should preserve query and fragment', () => {
      const routes = Routes.fromDataURL(data);
      expect(routes.intoURI('/github?foo=bar#baz')!.toString()).toBe(
        'https://www.githubstatus.com/api/v2/status.json?foo=bar#baz'
      );
      expect(routes.intoURI('/unknown?foo=bar#baz')!.toString()).toBe('http://localhost:8080/api/unknown?foo=bar#baz');
    });
  });
});

describe('uri', () => {
  describe('normalization', () => {
    it('should normalize localhost', () => {
      expect(URI.from('localhost').toString()).toBe('http://localhost/');
      expect(URI.from('localhost:80').toString()).toBe('http://localhost/');
      expect(URI.from('localhost:443').toString()).toBe('https://localhost/');
      expect(URI.from('http://localhost').toString()).toBe('http://localhost/');
      expect(URI.from('http://localhost:80').toString()).toBe('http://localhost/');
      expect(URI.from('https://localhost').toString()).toBe('https://localhost/');
      expect(URI.from('https://localhost:443').toString()).toBe('https://localhost/');
    });

    it('should normalize aws', () => {
      expect(URI.from('aws:us-east-1:lambda:function:my-function').toString()).toBe(
        'cloud://aws/aws:us-east-1:lambda:function:my-function'
      );
    });

    it('should support insecure prefix', () => {
      expect(URI.from('insecure+http://example.com').toString()).toBe('http://example.com/');
      expect(URI.from('insecure+http://example.com').insecure).toBe(true);
      expect(URI.from('insecure+https://example.com').toString()).toBe('https://example.com/');
      expect(URI.from('insecure+https://example.com').insecure).toBe(true);
      expect(URI.from('insecure+https://example.com:8443').toString()).toBe('https://example.com:8443/');
      expect(URI.from('insecure+https://example.com').insecure).toBe(true);
      expect(URI.from('insecure+localhost').toString()).toBe('http://localhost/');
      expect(URI.from('insecure+localhost').insecure).toBe(true);
      expect(URI.from('insecure+localhost:443').toString()).toBe('https://localhost/');
      expect(URI.from('insecure+localhost:443').insecure).toBe(true);
    });
  });
});
