import { ServiceImpl } from '@connectrpc/connect';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../../environment';
import { LambdaImageService } from './image';
import { Logger } from '../..';
import { LambdaFunction, tagify } from '.';
import { catchError, from, lastValueFrom, map, mergeAll, Observable, throwError, toArray } from 'rxjs';
import { Annotations } from './metadata';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ILambdaRuntimeService extends Partial<ServiceImpl<typeof CRI.RuntimeService>> {}

export class LambdaRuntimeService implements ILambdaRuntimeService {
  constructor(
    private environment: Environment,
    private imageService: LambdaImageService
  ) {}

  get log(): Logger {
    return this.environment.log;
  }

  createContainer = async (req: CRI.CreateContainerRequest): Promise<CRI.CreateContainerResponse> => {
    // DEVNOTE: CRI: Can be enabled by adding ROWDY_CRI environment variable
    // DEVNOTE: Routes: Can be enabled by adding ROWDY_ROUTES environment variable

    // TODO: podSandboxId -> find/create existing lambda function $LATEST
    // TODO: runtimeHandler -> withLayersFrom
    // TODO: log path -> CloudWatch log group/stream
    // TODO: stdin -> SNS

    let lambda = new LambdaFunction(
      'Container',
      this.imageService
        .withLayersFrom('ghcr.io/scaffoldly/rowdy:beta')
        .withAuthorization(req.config?.image?.annotations?.[Annotations.Images.ImageAuth])
    );
    const name = req.config?.metadata?.name;
    const image = req.config?.image?.image;
    const memory = req?.config?.linux?.resources?.memoryLimitInBytes;
    const command = `${req.config?.command?.join(' ') || ''} ${req.config?.args?.join(' ') || ''}`;
    const environment = req.config?.envs;
    const labels = req.config?.labels;
    const workingDir = req.config?.workingDir;

    // TODO: create function alias and function url during create phase
    // TODO: extract env from image config metadata
    // TODO: annotations into env vars?
    // TODO: ports from sandbox config?
    // TODO: arm64/amd64 from image annotation

    lambda = name ? lambda.withName(name) : lambda;
    lambda = image ? lambda.withImage(image) : lambda;
    lambda = memory ? lambda.withMemory(Math.floor(Number(memory) / (1024 * 1024))) : lambda;
    lambda = command ? lambda.withCommand(command) : lambda;
    lambda = environment ? environment.reduce((fn, env) => fn.withEnvironment(env.key, env.value), lambda) : lambda;
    lambda = labels ? Object.entries(labels).reduce((fn, [key, value]) => fn.withTag(key, value), lambda) : lambda;
    lambda = workingDir ? lambda.withWorkingDirectory(workingDir) : lambda;

    lambda = lambda = await lastValueFrom(lambda.observe());

    return {
      $typeName: 'runtime.v1.CreateContainerResponse',
      containerId: lambda.State.AliasArn!,
    };
  };

  listContainers = async (req: CRI.ListContainersRequest): Promise<CRI.ListContainersResponse> => {
    const functions: Observable<LambdaFunction>[] = [];

    // TODO: prevent image pulls

    if (req.filter?.id) {
      functions.push(new LambdaFunction('Container', this.imageService).withArn(req.filter.id));
    }

    if (Object.keys(req.filter?.labelSelector || {}).length) {
      functions.push(LambdaFunction.fromTags('Container', req.filter!.labelSelector!, this.imageService));
    }

    const containers: CRI.Container[] = await lastValueFrom(
      from(functions).pipe(
        mergeAll(Environment.CONCURRENCY),
        catchError((err) => {
          if (err.name === 'ResourceNotFoundException') {
            return [];
          } else {
            return throwError(() => err);
          }
        }),
        map(({ State, Status }) => {
          const container: CRI.Container = {
            $typeName: 'runtime.v1.Container',
            id: State.AliasArn || '',
            podSandboxId: State.FunctionArn || '',
            annotations: {
              ...tagify('com.amazonaws.lambda', Status.Configuration),
              ...tagify('run.rowdy.aws.lambda', State),
            },
            createdAt: 0n, // todo
            imageId: '',
            imageRef: State.ImageUri || '',
            labels: Status.Tags || {},
            state: CRI.ContainerState.CONTAINER_CREATED,
            metadata: {
              $typeName: 'runtime.v1.ContainerMetadata',
              name: Status.Configuration?.FunctionName || '',
              attempt: 0,
            },
          };

          return container;
        }),
        toArray()
      )
    );

    return {
      $typeName: 'runtime.v1.ListContainersResponse',
      containers,
    };
  };

  removeContainer = async (req: CRI.RemoveContainerRequest): Promise<CRI.RemoveContainerResponse> => {
    let lambda = await lastValueFrom(new LambdaFunction('Container', this.imageService).withArn(req.containerId));
    await lastValueFrom(lambda.delete());

    return {
      $typeName: 'runtime.v1.RemoveContainerResponse',
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
