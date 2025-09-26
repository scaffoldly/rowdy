import { Routes } from '@src';

describe('Routes', () => {
  describe('Status Router', () => {
    const data = new Routes()
      .withPath('/github', 'https://www.githubstatus.com/api/v2/status.json')
      .withPath('/circleci', 'https://status.circleci.com/api/v2/status.json')
      .withPath('/travisci', 'https://www.traviscistatus.com/api/v2/status.json')
      .withDefault('http://localhost:8080/api/')
      .intoDataURL();

    it('should route', () => {
      const routes = Routes.fromDataURL(data);
      expect(routes.rules).toHaveLength(4);
      expect(routes.intoURL('/github')!.toString()).toBe('https://www.githubstatus.com/api/v2/status.json');
      expect(routes.intoURL('/circleci')!.toString()).toBe('https://status.circleci.com/api/v2/status.json');
      expect(routes.intoURL('/travisci')!.toString()).toBe('https://www.traviscistatus.com/api/v2/status.json');
      expect(routes.intoURL('/unknown')!.toString()).toBe('http://localhost:8080/api/unknown');
      expect(routes.intoURL('/unknown/')!.toString()).toBe('http://localhost:8080/api/unknown/');
      expect(routes.intoURL('/also/unknown')!.toString()).toBe('http://localhost:8080/api/also/unknown');
      expect(routes.intoURL('/')!.toString()).toBe('http://localhost:8080/api/');
      expect(routes.intoURL('')!.toString()).toBe('http://localhost:8080/api/');
    });
  });
});
