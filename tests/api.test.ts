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
      api.image({ image: 'ubuntu' }).subscribe((response) => {
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

    // it('should resolve latest image', (done) => {
    //   api.image({ image: 'ubuntu:latest' }).subscribe((response) => {
    //     expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
    //     expect(response.kind).toBe('Image');
    //     expect(response.spec!.registry).toBe('registry-1.docker.io');
    //     expect(response.spec!.owner).toBe('library');
    //     expect(response.spec!.image).toBe('ubuntu');
    //     expect(response.spec!.tag).toBe('latest');
    //     expect(response.spec!.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    //     expect(response.status!.url).toBe(`https://registry-1.docker.io/v2/library/ubuntu/manifests/latest`);
    //     expect(response.status.code).toBe(200);
    //     done();
    //   });
    // }, 5000);

    // it('should resolve digest', (done) => {
    //   api
    //     .image({ image: 'ubuntu@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575' })
    //     .subscribe((response) => {
    //       expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
    //       expect(response.kind).toBe('Image');
    //       expect(response.spec!.registry).toBe('registry-1.docker.io');
    //       expect(response.spec!.owner).toBe('library');
    //       expect(response.spec!.image).toBe('ubuntu');
    //       expect(response.spec!.tag).toBeUndefined();
    //       expect(response.spec!.digest).toBe('sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575');
    //       expect(response.status!.url).toBe(
    //         `https://registry-1.docker.io/v2/library/ubuntu/manifests/sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575`
    //       );
    //       expect(response.status.code).toBe(200);
    //       done();
    //     });
    // }, 5000);

    // it('should resolve image with owner', (done) => {
    //   api.image({ image: 'scaffoldly/rowdy' }).subscribe((response) => {
    //     expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
    //     expect(response.kind).toBe('Image');
    //     expect(response.spec!.registry).toBe('registry-1.docker.io');
    //     expect(response.spec!.owner).toBe('scaffoldly');
    //     expect(response.spec!.image).toBe('rowdy');
    //     expect(response.spec!.tag).toBe('latest');
    //     expect(response.spec!.digest).toBeUndefined();
    //     expect(response.status!.url).toBe(`https://registry-1.docker.io/v2/scaffoldly/rowdy/manifests/latest`);
    //     expect(response.status.code).toBe(200);
    //     done();
    //   });
    // }, 5000);

    // it('should resolve image with registry and owner', (done) => {
    //   api.image({ image: 'ghcr.io/scaffoldly/rowdy' }).subscribe((response) => {
    //     expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
    //     expect(response.kind).toBe('Image');
    //     expect(response.spec!.registry).toBe('ghcr.io');
    //     expect(response.spec!.owner).toBe('scaffoldly');
    //     expect(response.spec!.image).toBe('rowdy');
    //     expect(response.spec!.tag).toBe('latest');
    //     expect(response.spec!.digest).toBeUndefined();
    //     expect(response.status!.url).toBe(`https://ghcr.io/v2/scaffoldly/rowdy/manifests/latest`);
    //     expect(response.status.code).toBe(200);
    //     done();
    //   });
    // }, 5000);

    // it('should resolve image with registry, owner, and tag', (done) => {
    //   api.image({ image: 'ghcr.io/scaffoldly/rowdy:latest' }).subscribe((response) => {
    //     expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
    //     expect(response.kind).toBe('Image');
    //     expect(response.spec!.registry).toBe('ghcr.io');
    //     expect(response.spec!.owner).toBe('scaffoldly');
    //     expect(response.spec!.image).toBe('rowdy');
    //     expect(response.spec!.tag).toBe('latest');
    //     expect(response.spec!.digest).toBeUndefined();
    //     expect(response.status!.url).toBe(`https://ghcr.io/v2/scaffoldly/rowdy/manifests/latest`);
    //     expect(response.status.code).toBe(200);
    //     done();
    //   });
    // }, 5000);

    // it('should resolve image with registry, owner, and digest', (done) => {
    //   api
    //     .image({
    //       image: 'ghcr.io/scaffoldly/rowdy@sha256:dbeff50e48e795cedfe50d0e35ac2ae3ed591e13d60015134a9247734d28936c',
    //     })
    //     .subscribe((response) => {
    //       expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
    //       expect(response.kind).toBe('Image');
    //       expect(response.spec!.registry).toBe('ghcr.io');
    //       expect(response.spec!.owner).toBe('scaffoldly');
    //       expect(response.spec!.image).toBe('rowdy');
    //       expect(response.spec!.tag).toBeUndefined();
    //       expect(response.spec!.digest).toBe('sha256:dbeff50e48e795cedfe50d0e35ac2ae3ed591e13d60015134a9247734d28936c');
    //       expect(response.status!.url).toBe(
    //         `https://ghcr.io/v2/scaffoldly/rowdy/manifests/sha256:dbeff50e48e795cedfe50d0e35ac2ae3ed591e13d60015134a9247734d28936c`
    //       );
    //       expect(response.status.code).toBe(200);
    //       done();
    //     });
    // }, 5000);

    // it('should resolve rowdy beta', (done) => {
    //   api.image({ image: 'ghcr.io/scaffoldly/rowdy:beta' }).subscribe((response) => {
    //     console.log('!!! got response', JSON.stringify(response, null, 2));
    //     expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
    //     expect(response.kind).toBe('Image');
    //     expect(response.spec!.registry).toBe('ghcr.io');
    //     expect(response.spec!.owner).toBe('scaffoldly');
    //     expect(response.spec!.image).toBe('rowdy');
    //     expect(response.spec!.tag).toBe('beta');
    //     expect(response.spec!.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    //     expect(response.status!.url).toBe(`https://ghcr.io/v2/scaffoldly/rowdy/manifests/beta`);
    //     expect(response.status.code).toBe(200);
    //     done();
    //   });
    // }, 5000);
  });
});
