import {
  CloudflareHeaders,
  CloudFrontHeaders,
  cdnHeaders,
  element,
  isListed,
  originOf,
  portIn,
  ProxyHeaders,
  splitElements,
} from '../../src/cdn';

describe('cdn headers', () => {
  it('builds an origin from any proto, hostname and port', () => {
    expect(originOf('https', 'app.example', '443')).toBe('https://app.example');
    expect(originOf('http', 'app.example', '80')).toBe('http://app.example');
    expect(originOf('https', 'app.example', '80')).toBe('https://app.example:80');
    expect(originOf('https', 'App.Example:443', '8443')).toBe('https://app.example');
    expect(originOf('https', 'app.example:3000', '443')).toBe('https://app.example:3000');
    expect(originOf('http', '[::1]', '8080')).toBe('http://[::1]:8080');
    expect(originOf('http', 'localhost')).toBe('http://localhost');
  });

  it('finds the port in a host, IPv6 literals included', () => {
    expect(portIn('app.example')).toBeUndefined();
    expect(portIn('app.example:8443')).toBe('8443');
    expect(portIn('[::1]')).toBeUndefined();
    expect(portIn('[::1]:8080')).toBe('8080');
  });

  describe('cdnHeaders', () => {
    it('picks CloudFront by X-Amz-Cf-Id or CloudFront-Forwarded-Proto', () => {
      expect(cdnHeaders({ 'x-amz-cf-id': 'abc' })).toBeInstanceOf(CloudFrontHeaders);
      expect(cdnHeaders({ 'CloudFront-Forwarded-Proto': 'https' })).toBeInstanceOf(CloudFrontHeaders);
    });

    it('picks Cloudflare by CF-Ray or CF-Visitor', () => {
      expect(cdnHeaders({ 'cf-ray': '8a1b2c3d4e5f6a7b-IAD' })).toBeInstanceOf(CloudflareHeaders);
      expect(cdnHeaders({ 'cf-visitor': '{"scheme":"https"}' })).toBeInstanceOf(CloudflareHeaders);
    });

    it('falls back to a plain proxy', () => {
      expect(cdnHeaders({ 'x-forwarded-host': 'app.example' })).toBeInstanceOf(ProxyHeaders);
      expect(CloudFrontHeaders.from({})).toBeUndefined();
      expect(CloudflareHeaders.from({})).toBeUndefined();
    });
  });

  describe('proto', () => {
    it("reads CloudFront's scheme before the standard headers", () => {
      const cdn = cdnHeaders({ 'cloudfront-forwarded-proto': 'HTTP', 'x-forwarded-proto': 'https' });
      expect(cdn.proto()).toBe('http');
      expect(cdnHeaders({ 'x-amz-cf-id': 'abc', 'x-forwarded-proto': 'https' }).proto()).toBe('https');
    });

    it("reads Cloudflare's X-Forwarded-Proto, then CF-Visitor, skipping one it cannot parse", () => {
      expect(cdnHeaders({ 'cf-visitor': '{"scheme":"http"}', 'x-forwarded-proto': 'https' }).proto()).toBe('https');
      expect(cdnHeaders({ 'cf-visitor': '{"scheme":"http"}' }).proto()).toBe('http');
      expect(cdnHeaders({ 'cf-ray': 'abc', 'cf-visitor': 'not json' }).proto()).toBeUndefined();
    });

    it('ignores Forwarded behind a CDN, which never sets it', () => {
      const forged = { forwarded: 'proto=http;host=evil.example', 'x-forwarded-host': 'app.example' };
      const cloudfront = cdnHeaders({ ...forged, 'x-amz-cf-id': 'abc', 'cloudfront-forwarded-proto': 'https' });
      expect([cloudfront.host(), cloudfront.proto()]).toEqual(['app.example', 'https']);
      const cloudflare = cdnHeaders({ ...forged, 'cf-ray': 'abc', 'x-forwarded-proto': 'https' });
      expect([cloudflare.host(), cloudflare.proto()]).toEqual(['app.example', 'https']);
    });

    it('reads Forwarded before X-Forwarded-Proto, from the client-most element', () => {
      const cdn = cdnHeaders({ forwarded: 'proto=http;host=a.example, proto=https', 'x-forwarded-proto': 'https' });
      expect(cdn.proto()).toBe('http');
      expect(cdn.host()).toBe('a.example');
    });
  });

  describe('host', () => {
    it('reads Forwarded host=, unquoted, before the first X-Forwarded-Host', () => {
      expect(cdnHeaders({ forwarded: 'host="app.example:8443"' }).host()).toBe('app.example:8443');
      expect(cdnHeaders({ 'x-forwarded-host': 'app.example, proxy.internal' }).host()).toBe('app.example');
      expect(cdnHeaders({ Host: 'abc.lambda-url.us-east-1.on.aws' }).requestHost()).toBe(
        'abc.lambda-url.us-east-1.on.aws'
      );
    });
  });
});

describe('listed hosts', () => {
  const hosts = ['https://*.app.example', 'http://*.dev.example:8080', 'https://**.deep.example'];

  it.each([
    ['https://app.example', true],
    ['https://www.app.example', true],
    ['https://api-2.app.example', true],
    ['https://a.b.app.example', false],
    ['https://evilapp.example', false],
    ['https://www.app.example:8443', false],
    ['http://www.app.example', false],
    ['http://x.dev.example:8080', true],
    ['http://x.dev.example', false],
    ['http://dev.example:8080', true],
    ['http://dev.example', false],
    ['https://example', false],
    ['https://deep.example', true],
    ['https://a.deep.example', true],
    ['https://a.b.c.d.e.deep.example', true],
    ['https://a..deep.example', false],
    ['https://notdeep.example', false],
    ['https://a.deep.example:8443', false],
    ['https://x.dev.example:8080', false],
  ])('%s is listed: %p', (origin, listed) => {
    expect(isListed(hosts, origin)).toBe(listed);
  });
});

describe('forwarded elements', () => {
  it('quotes what is not a token and brackets IPv6 nodes', () => {
    expect(element({ for: '192.0.2.60', host: 'app.example', proto: 'https', by: '_rowdy' })).toBe(
      'for=192.0.2.60;host=app.example;proto=https;by=_rowdy'
    );
    expect(element({ for: '2001:db8::1', host: 'app.example:8443' })).toBe(
      'for="[2001:db8::1]";host="app.example:8443"'
    );
    expect(element({ host: 'a"b' })).toBe('host="a\\"b"');
    expect(element({ for: undefined })).toBeUndefined();
  });

  it('splits on commas outside quoted strings', () => {
    expect(splitElements('for=a, host="x,y";proto=https ,for=b')).toEqual(['for=a', 'host="x,y";proto=https', 'for=b']);
    expect(splitElements('')).toEqual([]);
  });

  it("keeps the elements received, then adds the hop's own claims", () => {
    const cdn = cdnHeaders({
      'x-amz-cf-id': 'abc',
      forwarded: 'host=evil.example',
      'x-forwarded-for': '203.0.113.1, 198.51.100.7',
      'x-forwarded-host': 'www.app.example',
      'cloudfront-forwarded-proto': 'https',
    });
    expect(cdn.elements()).toEqual([
      'host=evil.example',
      'for=198.51.100.7;host=www.app.example;proto=https;by=_cloudfront',
    ]);
    expect(cdnHeaders({ 'cf-ray': 'abc', 'cf-connecting-ip': '198.51.100.8' }).elements()).toEqual([
      'for=198.51.100.8;by=_cloudflare',
    ]);
    expect(cdnHeaders({ host: 'abc.lambda-url.us-east-1.on.aws' }).elements()).toEqual([]);
  });
});
