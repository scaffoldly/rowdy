import { Rowdy, Logger } from '@scaffoldly/rowdy';
import { lastValueFrom } from 'rxjs';
import { PullImageOptions } from 'src/api/types';

describe('api', () => {
  const logger = new Logger();
  const rowdy = new Rowdy(logger, new AbortController().signal);
  const aws = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? it : it.skip;

  describe('images', () => {
    describe('pullImage', () => {
      const tests = [
        {
          image: 'alpine:20250108',
          platform: undefined as PullImageOptions['platform'], // will default to linux/amd64
          // TODO: Figure out why SHAs are changing in the createHash functions
          ///^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/alpine@sha256:20c6c97faaa88f32bbbc45696d259f0c01404a4ec2f1fa4fa8bc5aa5140443ec$/,
          imageRef:
            /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/alpine@sha256:0939ba102996e2e641b6bd4962456360aaeca161c748b9853b9b5aa9a7a6d2e3$/,
        },
        {
          image: 'ubuntu:noble-20251001',
          platform: undefined as PullImageOptions['platform'], // will default to linux/amd64
          // TODO: Figure out why SHAs are changing in the createHash functions
          ///^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/ubuntu@sha256:d22e4fb389065efa4a61bb36416768698ef6d955fe8a7e0cdb3cd6de80fa7eec$/,
          imageRef:
            /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/ubuntu@sha256:8df6481f1c906d7338a63f85e91add57d8c5f566ab7c2e8e63f5403d994d7886$/,
        },
        {
          image: 'ubuntu:noble-20251001',
          platform: 'linux/arm64' as PullImageOptions['platform'],
          // TODO: Figure out why SHAs are changing in the createHash functions
          ///^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/ubuntu@sha256:3372ac029cdf2ade8c2f8373590af8ca6422e84b99bf62c60e8df2e3fa5ee7e7$/,
          imageRef:
            /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/ubuntu@sha256:25349802565b2af7f69326dedbb7779613a62e0d54bed3b6ad3523645cffe044$/,
        },
        {
          image: 'busybox',
          imageRef: /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/busybox@sha256:[a-f0-9]{64}$/,
        },
      ];

      describe('aws', () => {
        tests.forEach(({ image, imageRef, platform }) => {
          aws(
            `should pull ${image} on ${platform || 'default'} platform`,
            async () => {
              const { Image: pulledImage, ImageUri: pulledImageRef } = await lastValueFrom(
                rowdy.images.pullImage(image, { platform })
              );
              expect(pulledImage).toEqual(image);
              expect(pulledImageRef).toMatch(imageRef);
            },
            60000
          );
        });
      });

      aws('should inject layers', async () => {
        const { Image: pulledImage, ImageUri: pulledImageRef } = await lastValueFrom(
          rowdy.images.pullImage('busybox', { layersFrom: 'ghcr.io/scaffoldly/rowdy:beta' })
        );
        console.log('Pulled Image Ref:', pulledImageRef);
        console.log('Pulled Image:', pulledImage);
      });
    });
  });
});
