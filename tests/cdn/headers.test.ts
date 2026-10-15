import { CloudflareHeaders, CloudFrontHeaders, cdnHeaders, originOf, portIn, ProxyHeaders } from '../../src/cdn';

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

    it("reads Cloudflare's CF-Visitor before the standard headers, and skips one it cannot parse", () => {
      expect(cdnHeaders({ 'cf-visitor': '{"scheme":"http"}', 'x-forwarded-proto': 'https' }).proto()).toBe('http');
      expect(cdnHeaders({ 'cf-visitor': 'not json', 'x-forwarded-proto': 'https' }).proto()).toBe('https');
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
