import { ConnectError, ServiceImpl } from '@connectrpc/connect';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { Logger } from '../../log';
import { lastValueFrom } from 'rxjs';
import { Rowdy } from '../../api';
import { Environment } from '../../environment';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ILambdaImageService extends Partial<ServiceImpl<typeof CRI.ImageService>> {}

export class LambdaImageService implements ILambdaImageService {
  constructor(private environment: Environment) {}

  get log(): Logger {
    return this.environment.log;
  }

  get images(): Rowdy['images'] {
    return this.environment.rowdy.images;
  }

  pullImage = async (req: CRI.PullImageRequest): Promise<CRI.PullImageResponse> => {
    // TODO: Support for platform annotation
    const { image } = req.image || {};
    if (!image) {
      throw new ConnectError('No image specified');
    }
    const { imageRef } = await lastValueFrom(this.images.pullImage(image, { layersFrom: 'scaffoldly/rowdy:beta' }));
    return {
      $typeName: 'runtime.v1.PullImageResponse',
      imageRef,
    };
  };

  pullImageSpec = async (req: CRI.ImageSpec, config: CRI.PodSandboxConfig): Promise<CRI.ImageSpec> => {
    const { imageRef } = await this.pullImage({
      $typeName: 'runtime.v1.PullImageRequest',
      image: req,
      sandboxConfig: config,
    });

    return {
      $typeName: 'runtime.v1.ImageSpec',
      annotations: req.annotations,
      image: imageRef,
      runtimeHandler: req.runtimeHandler,
      userSpecifiedImage: req.userSpecifiedImage,
    };
  };

  listImages = async (req: CRI.ListImagesRequest): Promise<CRI.ListImagesResponse> => {
    if (req.filter) {
      throw new ConnectError('Image filtering not supported');
    }
    return {
      $typeName: 'runtime.v1.ListImagesResponse',
      images: [],
    };
  };
}
