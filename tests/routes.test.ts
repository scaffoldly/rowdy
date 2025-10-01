import { Routes, URI } from '@src';

describe('routes', () => {
  describe('path chaining', () => {
    const data = new Routes()
      .withPath('/github', 'https://www.githubstatus.com/api/v2/status.json')
      .withPath('/circleci', 'https://status.circleci.com/api/v2/status.json')
      .withPath('/travisci', 'https://www.traviscistatus.com/api/v2/status.json')
      .withDefault('http://localhost:8080/api/')
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
