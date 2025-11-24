import { ServiceImpl } from '@connectrpc/connect';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../../environment';
import { LambdaImageService } from './image';
import { Logger } from '../..';
import { LambdaFunction } from '.';
import { lastValueFrom } from 'rxjs';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ILambdaRuntimeService extends Partial<ServiceImpl<typeof CRI.RuntimeService>> {}

export class LambdaRuntimeService implements ILambdaRuntimeService {
  constructor(
    private environment: Environment,
    private image: LambdaImageService
  ) {}

  get log(): Logger {
    return this.environment.log;
  }

  createContainer = async (req: CRI.CreateContainerRequest): Promise<CRI.CreateContainerResponse> => {
    let lambda = new LambdaFunction('Container', this.image);
    const name = req.config?.metadata?.name || req.sandboxConfig?.metadata?.name;
    const image = req.config?.image?.image;
    const memory =
      req?.config?.linux?.resources?.memoryLimitInBytes || req.sandboxConfig?.linux?.resources?.memoryLimitInBytes;

    lambda = name ? lambda.withName(name) : lambda;
    lambda = image ? lambda.withImage(image) : lambda;
    lambda = memory ? lambda.withMemory(Math.floor(Number(memory) / (1024 * 1024))) : lambda;
    lambda = await lastValueFrom(lambda.observe(this.environment.signal));

    // TODO: environment
    // TODO: debug/trace
    // TODO: command/entrypoint

    return {
      $typeName: 'runtime.v1.CreateContainerResponse',
      containerId: lambda.State.FunctionArn!,
    };
  };

  version = async (req: CRI.VersionRequest): Promise<CRI.VersionResponse> => {
    return {
      $typeName: 'runtime.v1.VersionResponse',
      version: req.version,
      runtimeName: this.environment.name,
      runtimeVersion: this.environment.version,
      runtimeApiVersion: 'v1',
    };
  };
}
