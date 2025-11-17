import { ServiceImpl } from '@connectrpc/connect';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../../environment';
import { LambdaImageService } from './image';
import { Logger } from '../..';
import { SandboxResource } from './sandbox';
import { ContainerResource } from './container';
import { ConfigFactory } from './config';

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

  runPodSandbox = async (req: CRI.RunPodSandboxRequest): Promise<CRI.RunPodSandboxResponse> => {
    const factory = ConfigFactory.fromSandboxRequest(req);

    const image = await this.image.pullImageSpec(factory.ImageSpec, factory.SandboxConfig);
    const resource = new SandboxResource(this.environment, factory.RunPodSandboxRequest, image);
    const sandbox = await resource.Sandbox;

    return {
      $typeName: 'runtime.v1.RunPodSandboxResponse',
      podSandboxId: sandbox.id,
    };
  };

  listPodSandbox = async (req: CRI.ListPodSandboxRequest): Promise<CRI.ListPodSandboxResponse> => {
    if (req.filter?.id) {
      const { sandbox } = await SandboxResource.from(this.environment, req.filter.id);
      return {
        $typeName: 'runtime.v1.ListPodSandboxResponse',
        items: [sandbox],
      };
    }

    return {
      $typeName: 'runtime.v1.ListPodSandboxResponse',
      items: [],
    };
  };

  createContainer = async (req: CRI.CreateContainerRequest): Promise<CRI.CreateContainerResponse> => {
    const { factory, sandbox } = await SandboxResource.from(this.environment, req.podSandboxId);
    factory.withImage(req?.config?.image?.image);
    // TODO: Check if image needs to be pulled (e.g. not in ecr)
    // const image = await this.image.pullImageSpec(factory.ImageSpec, factory.SandboxConfig);
    const resource = new ContainerResource(this.environment, sandbox, req, factory.ImageSpec);
    const container = await resource.Container;

    return {
      $typeName: 'runtime.v1.CreateContainerResponse',
      containerId: container.id,
    };
  };

  // createContainer = async (req: CRI.CreateContainerRequest): Promise<CRI.CreateContainerResponse> => {
  //   const image = await this.image.pullImage({
  //     $typeName: 'runtime.v1.PullImageRequest',
  //     image: req.config?.image,
  //     sandboxConfig: req.sandboxConfig,
  //   });

  //   const resource = new SandboxResource(req, image);
  //   const sandbox = await resource.Sandbox;

  //   return {
  //     $typeName: 'runtime.v1.CreateContainerResponse',
  //     containerId: sandbox.id,
  //   };
  // };

  // containerStatus = async (req: CRI.ContainerStatusRequest): Promise<CRI.ContainerStatusResponse> => {
  //   const sandbox = await SandboxResource.fromContainerId(req.containerId);

  //   return {
  //     $typeName: 'runtime.v1.ContainerStatusResponse',
  //     info: {},
  //     status: {
  //       $typeName: 'runtime.v1.ContainerStatus',
  //       annotations: sandbox.annotations,
  //       createdAt: sandbox.createdAt,
  //       id: sandbox.id,
  //       state: sandbox.state,
  //       labels: sandbox.labels,
  //     },
  //   };
  //   throw new Error('Method not implemented.');
  // };

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
