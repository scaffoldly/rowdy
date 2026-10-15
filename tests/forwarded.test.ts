import { originOf, portIn } from '../src/forwarded';

describe('forwarded', () => {
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
});
