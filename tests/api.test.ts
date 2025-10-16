import { Api, Logger } from '@scaffoldly/rowdy';

describe('api', () => {
  const api = new Api(new Logger().withDebugging().withTracing());

  describe('health', () => {
    it('should respond to health', (done) => {
      api.health().subscribe((response) => {
        expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
        expect(response.kind).toBe('Health');
        expect(response.spec!.healthy).toBe(true);
        expect(response.status.code).toBe(200);
        done();
      });
    });
  });

  describe('image', () => {
    it('should resolve ubuntu', (done) => {
      api.Images.getImage({ image: 'ubuntu' }).subscribe((response) => {
        expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
        expect(response.kind).toBe('Image');
        expect(response.spec!.image).toBe('registry-1.docker.io/library/ubuntu:latest');
        expect(response.status!.registry).toBe('registry-1.docker.io');
        expect(response.status!.namespace).toBe('library');
        expect(response.status!.name).toBe('ubuntu');
        expect(response.status!.reference).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(response.status!.tags).toContain('latest');
        expect(response.status.code).toBe(200);
        done();
      });
    }, 5000);
  });
});
