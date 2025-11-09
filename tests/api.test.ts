import { Rowdy, Logger } from '@scaffoldly/rowdy';
import { lastValueFrom } from 'rxjs';

describe('api', () => {
  const logger = new Logger();
  const rowdy = new Rowdy(logger, new AbortController().signal);
  const aws = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? it : it.skip;

  describe('images', () => {
    describe('pullImage', () => {
      describe('aws', () => {
        aws(
          'should pull alpine from mirror.gcr.io',
          async () => {
            const { image, imageRef } = await lastValueFrom(
              rowdy.images.pullImage('alpine', { registry: 'mirror.gcr.io' })
            );
            expect(image).toEqual('alpine');
            expect(imageRef).toMatch(
              /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/alpine@sha256:[a-f0-9]{64}$/
            );
          },
          60000
        );
        aws('should pull ubuntu from mirror.gcr.io', async () => {
          const { image, imageRef } = await lastValueFrom(
            rowdy.images.pullImage('ubuntu', { registry: 'mirror.gcr.io' })
          );
          expect(image).toEqual('ubuntu');
          expect(imageRef).toMatch(
            /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/ubuntu@sha256:[a-f0-9]{64}$/
          );
        });
        aws('should pull busybox from mirror.gcr.io', async () => {
          const { image, imageRef } = await lastValueFrom(
            rowdy.images.pullImage('busybox', { registry: 'mirror.gcr.io' })
          );
          expect(image).toEqual('busybox');
          expect(imageRef).toMatch(
            /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/busybox@sha256:[a-f0-9]{64}$/
          );
        });
      });
    });
  });
});
