import { Api } from '@scaffoldly/rowdy';

describe('api', () => {
  const api = new Api();

  describe('health', () => {
    it('should respond to health', (done) => {
      api.health().subscribe((response) => {
        expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
        expect(response.kind).toBe('Health');
        expect(response.spec!.healthy).toBe(true);
        expect(response.status.code).toBe(200);
        expect(response.status.headers['content-type']).toBe('application/json; charset=utf-8');
        done();
      });
    });
  });
});
