import { ServiceImpl } from '@connectrpc/connect';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../../environment';
import { LambdaImageService } from './image';
import {
  // CreateFunctionCommand,
  // GetFunctionCommand,
  LambdaClient,
  // ListFunctionsCommand,
  // PublishLayerVersionCommand,
  // PublishVersionCommand,
  // UpdateFunctionCodeCommand,
} from '@aws-sdk/client-lambda';
import { Logger } from '../..';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ILambdaRuntimeService extends Partial<ServiceImpl<typeof CRI.RuntimeService>> {}

export class LambdaRuntimeService implements ILambdaRuntimeService {
  private lambda: LambdaClient = new LambdaClient(this.environment);

  constructor(
    private environment: Environment,
    private image: LambdaImageService
  ) {}

  get log(): Logger {
    return this.environment.log;
  }

  get functionName(): Promise<string> {
    return this.version({ $typeName: 'runtime.v1.VersionRequest', version: this.environment.version }).then(
      ({ runtimeName, runtimeVersion }) =>
        `${runtimeName.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase()}_${runtimeVersion}`
    );
  }

  createContainer = async (req: CRI.CreateContainerRequest): Promise<CRI.CreateContainerResponse> => {
    const { items: sandboxes } = await this.listPodSandbox({ $typeName: 'runtime.v1.ListPodSandboxRequest' });
    // const { podSandboxId } = req;

    const { imageRef } = await this.image.pullImage({
      $typeName: 'runtime.v1.PullImageRequest',
      image: req.config?.image,
      sandboxConfig: req.sandboxConfig,
    });

    return {
      $typeName: 'runtime.v1.CreateContainerResponse',
      containerId: `todo: ${imageRef} on sandbox ${sandboxes[0]?.id}`,
    };
  };

  listPodSandbox = async (_req: CRI.ListPodSandboxRequest): Promise<CRI.ListPodSandboxResponse> => {
    const functionName = await this.functionName;
    // let sandbox = await this.lambda
    //   .send(new GetFunctionCommand({ FunctionName: await this.functionName }))
    //   .then((res) => res.Configuration)
    //   .catch((err) => {
    //     this.log.warn(`Unable to get function ${functionName}: ${err.message}`);
    //     return undefined;
    //   });

    // new UpdateFunctionCodeCommand({});

    // if (!sandbox) {
    //   const { imageRef } = await this.image.pullImage({
    //     $typeName: 'runtime.v1.PullImageRequest',
    //     image: {
    //       $typeName: 'runtime.v1.ImageSpec',
    //       image:
    //     }
    //   });

    //   await this.lambda.send(
    //     new CreateFunctionCommand({
    //       FunctionName: functionName,
    //       Code: { ImageUri: 'todo' },
    //       Role: 'todo',
    //       PackageType: 'Image',
    //     })
    //   );
    // }

    return {
      $typeName: 'runtime.v1.ListPodSandboxResponse',
      items: [
        {
          $typeName: 'runtime.v1.PodSandbox',
          id: functionName,
          annotations: { env: JSON.stringify(this.environment.env) },
          labels: {},
          createdAt: BigInt(0),
          runtimeHandler: 'aws.lambda',
          state: CRI.PodSandboxState.SANDBOX_READY,
        },
      ],
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
