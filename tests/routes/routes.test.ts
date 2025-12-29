import { Routes, URI } from '@scaffoldly/rowdy';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';

// TODO
// expect(routes.intoURI('/')!.toString()).toBe('file:///var/www/html/');
// expect(routes.intoURI('/stdout')!.toString()).toBe('rowdy://stdout/');
// expect(routes.intoURI('/stderr')!.toString()).toBe('rowdy://stderr/');

describe('routes', () => {
  describe('default', () => {
    it('should handle default', () => {
      const routes = Routes.default();
      expect(routes.rules).toHaveLength(11);
      expect(routes.intoURI('')!.toString()).toBe('rowdy://http:404/');
      expect(routes.intoURI('/foo/bar')!.toString()).toBe('rowdy://http:404/foo/bar');
      expect(routes.intoURI('/foo/bar?q=1')!.toString()).toBe('rowdy://http:404/foo/bar?q=1');
      expect(routes.intoURI('/@rowdy/health')!.toString()).toBe('rowdy://health/');
      expect(routes.intoURI('/@rowdy/health/baz')!.toString()).toBe('rowdy://http:404/%40rowdy/health/baz');
      expect(routes.intoURI('/@rowdy/ping')!.toString()).toBe('rowdy://ping/');
      expect(routes.intoURI('/@rowdy/ping/baz')!.toString()).toBe('rowdy://http:404/%40rowdy/ping/baz');
      expect(routes.intoURI('/@rowdy/routes')!.toString()).toBe('rowdy://routes/');
      expect(routes.intoURI('/@rowdy/routes/baz')!.toString()).toBe('rowdy://http:404/%40rowdy/routes/baz');
      expect(routes.intoURI('/@rowdy/200')!.toString()).toBe('rowdy://http:200/');
      expect(routes.intoURI('/@rowdy/200/baz')!.toString()).toBe('rowdy://http:404/%40rowdy/200/baz');
      expect(routes.intoURI('/@rowdy/500')!.toString()).toBe('rowdy://http:500/');
      expect(routes.intoURI('/@rowdy/500/baz')!.toString()).toBe('rowdy://http:404/%40rowdy/500/baz');
      expect(routes.intoURI('/@rowdy/cri/foo/bar/baz')!.toString()).toBe('rowdy://cri/foo/bar/baz');
      expect(routes.intoURI('/@rowdy/cri/foo/bar/baz?bing=bong')!.toString()).toBe('rowdy://cri/foo/bar/baz?bing=bong');
      expect(routes.intoURI('/@rowdy/version')!.toString()).toBe('rowdy://version/');
    });
  });

  describe('preservation', () => {
    it('should preserve query and fragment', () => {
      const routes = Routes.empty()
        .withPath('/foo', 'http://example.com/foo')
        .withPath('/bar', 'http://example.com/bar?extra=param');
      expect(routes.intoURI('/foo?bing=bong#baz')!.toString()).toBe('http://example.com/foo?bing=bong#baz');
      expect(routes.intoURI('/bar?bing=bong#baz')!.toString()).toBe('http://example.com/bar?extra=param&bing=bong#baz');
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
      expect(routes.rules).toHaveLength(7);
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

  describe('from url', () => {
    it('should create from relative path', () => {
      const path = `${__dirname}/routes.yaml`;
      const routes = Routes.fromURL(path);
      expect(routes.intoURI('/foo')!.toString()).toBe('http://localhost:3000/foo');
    });
  });

  describe('kubernetes-dashboard', () => {
    it('should route kubernetes-dashboard', () => {
      const file = `${tmpdir()}/routes-${Date.now()}.yaml`;
      writeFileSync(
        file,
        `
apiVersion: rowdy.run/v1alpha1
kind: Routes
spec:
  default: "http://localhost:8020/"
  paths:
    "/api/v1/login": "http://localhost:8000/api/v1/login"
    "/api/v1/csrftoken/login": "http://localhost:8000/api/v1/csrftoken/login"
    "/api/v1/me": "http://localhost:8000/api/v1/me"
    "/api{/*path}": "http://localhost:8010/api/*path"
`
      );
      const routes = Routes.fromPath(file);

      expect(routes.intoURI('/api/v1/login')!.toString()).toBe('http://localhost:8000/api/v1/login');
      expect(routes.intoURI('/api/v1/csrftoken/login')!.toString()).toBe(
        'http://localhost:8000/api/v1/csrftoken/login'
      );
      expect(routes.intoURI('/api/v1/me')!.toString()).toBe('http://localhost:8000/api/v1/me');
      expect(routes.intoURI('/en.main.143734868f788885.js')!.toString()).toBe(
        'http://localhost:8020/en.main.143734868f788885.js'
      );
      expect(routes.intoURI('/api/v1/namespace')!.toString()).toBe('http://localhost:8010/api/v1/namespace');
      expect(routes.intoURI('/api/v1/node?itemsPerPage=10&page=1&sortBy=d,creationTimestamp')!.toString()).toBe(
        'http://localhost:8010/api/v1/node?itemsPerPage=10&page=1&sortBy=d%2CcreationTimestamp'
      );
    });
  });
});

describe('uri', () => {
  describe('normalization', () => {
    it('should normalize localhost', () => {
      expect(URI.from('localhost').toString()).toBe('http://localhost/');
      expect(URI.from('localhost:80').toString()).toBe('http://localhost/');
      expect(URI.from('localhost:443').toString()).toBe('https://localhost/');
      expect(URI.from('localhost:3000').toString()).toBe('http://localhost:3000/');
      expect(URI.from('http://localhost').toString()).toBe('http://localhost/');
      expect(URI.from('http://localhost:80').toString()).toBe('http://localhost/');
      expect(URI.from('http://localhost:3000').toString()).toBe('http://localhost:3000/');
      expect(URI.from('https://localhost').toString()).toBe('https://localhost/');
      expect(URI.from('https://localhost:443').toString()).toBe('https://localhost/');
      expect(URI.from('https://localhost:8443').toString()).toBe('https://localhost:8443/');
    });

    it('should normalize aws', () => {
      expect(URI.from('aws:us-east-1:lambda:function:my-function').toString()).toBe(
        'cloud://aws/aws:us-east-1:lambda:function:my-function'
      );
    });

    it('should not normalize unknown schemes', () => {
      expect(URI.from('something:unknown').toString()).toBe('something:unknown');
      expect(URI.from('something:unknown/bing/boop/bop').toString()).toBe('something:unknown/bing/boop/bop');
    });

    it('should provide server', () => {
      expect(URI.from('foo/bar').server).toBe('rowdy://error/?__error__=Invalid+URI%3A+foo%2Fbar');
      expect(URI.from('http://example.com').server).toBe('http://example.com');
      expect(URI.from('https://example.com').server).toBe('https://example.com');
      expect(URI.from('http://example.com:8080').server).toBe('http://example.com:8080');
      expect(URI.from('https://example.com:8443').server).toBe('https://example.com:8443');
      expect(URI.from('https://example.com:8443/foo/bar/baz').server).toBe('https://example.com:8443');
      expect(URI.from('localhost').server).toBe('http://localhost');
      expect(URI.from('localhost:80').server).toBe('http://localhost');
      expect(URI.from('localhost:443').server).toBe('https://localhost');
      expect(URI.from('localhost:3000').server).toBe('http://localhost:3000');
      expect(URI.from('http://localhost').server).toBe('http://localhost');
      expect(URI.from('http://localhost:80').server).toBe('http://localhost');
      expect(URI.from('aws:us-east-1:lambda:function:my-function').server).toBe(
        'cloud://aws/aws:us-east-1:lambda:function:my-function'
      );
      expect(URI.from('something:unknown').server).toBe('something:unknown');
      expect(URI.from('something:unknown/bing/boop/bop').server).toBe('something:unknown/bing/boop/bop');
    });

    it('should provide error', () => {
      expect(URI.from('http://example.com').error).toBeUndefined();
      expect(URI.from('foo/bar').error).toBe('Invalid URI: foo/bar');
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
