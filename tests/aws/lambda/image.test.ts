import { Environment, Logger } from '@scaffoldly/rowdy';
import { of } from 'rxjs';
import { create } from '@bufbuild/protobuf';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { deploySources } from '../../../src/api/internal/layers';
import { LambdaImageService } from '../../../src/aws/lambda/image';
import { TPulledImage } from '../../../src/api/types';

describe('lambda image service', () => {
  it('passes every layers-from source to pullImage, rowdy last', async () => {
    const environment = new Environment(new Logger());
    const pulled: TPulledImage = { ImageUri: 'x', Image: 'busybox' };
    const pullImage = jest.spyOn(environment.rowdy.images, 'pullImage').mockReturnValue(of(pulled));

    await new LambdaImageService(environment)
      .withLayersFrom(deploySources(['ghcr.io/tunnel-pizza/tunneld:latest-layer']))
      .pullImage(create(CRI.PullImageRequestSchema, { image: { image: 'busybox' } }));

    expect(pullImage).toHaveBeenCalledWith('busybox', {
      layersFrom: ['ghcr.io/tunnel-pizza/tunneld:latest-layer', 'ghcr.io/scaffoldly/rowdy:beta'],
    });
  });
});
