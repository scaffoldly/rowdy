import { Rowdy, Logger } from '@scaffoldly/rowdy';
import { lastValueFrom } from 'rxjs';

describe('api', () => {
  // const logger = new Logger().withDebugging().withTracing();
  const logger = new Logger();
  const rowdy = new Rowdy(logger);
  const aws = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? it : it.skip;

  describe('health', () => {
    it('should respond to health', (done) => {
      rowdy.health().subscribe((response) => {
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
      rowdy.Images.getImage({ image: 'ubuntu' }).subscribe((response) => {
        expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
        expect(response.kind).toBe('Image');
        expect(response.spec!.image).toBe('mirror.gcr.io/library/ubuntu:latest');
        expect(response.status!.registry).toBe('mirror.gcr.io');
        expect(response.status!.namespace).toBe('library');
        expect(response.status!.name).toBe('ubuntu');
        expect(response.status!.reference).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(response.status!.tags).toContain('latest');
        expect(response.status.code).toBe(200);
        done();
      });
    }, 5000);

    aws('should copy from gcr mirror to private ecr', async () => {
      // TODO: support for
      // - "mirror.gcr.io/ubuntu:latest"
      // - "public.ecr.aws/docker/library/ubuntu:latest"
      const response = await lastValueFrom(rowdy.Images.putImage({ image: 'mirror.gcr.io/library/alpine:latest' }));
      expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
      expect(response.status.code).toBe(200);
    });
  });

  describe('registry', () => {
    describe('ecr', () => {
      aws(
        'should infer an ecr registry',
        (done) => {
          rowdy.Registry.getRegistry().subscribe((response) => {
            expect(response.apiVersion).toBe('rowdy.run/v1alpha1');
            expect(response.kind).toBe('Registry');
            expect(response.spec!.registry).toMatch(/\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/);
            expect(response.spec!.authorization).toBeUndefined();
            expect(response.status.registry).toMatch(/\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/);
            expect(response.status.code).toBe(200);
            done();
          });
        },
        5000
      );
    });
  });
});
