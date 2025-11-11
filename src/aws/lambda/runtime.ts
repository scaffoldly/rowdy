import { ServiceImpl } from '@connectrpc/connect';
import { CRI } from '@scaffoldly/rowdy-grpc';
import { Environment } from '../../environment';
import { LambdaImageService } from './image';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { Logger } from '../..';
import { concatMap, defer, EMPTY, expand, filter, lastValueFrom, map, toArray } from 'rxjs';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ILambdaRuntimeService extends Partial<ServiceImpl<typeof CRI.RuntimeService>> {}

export class LambdaRuntimeService implements ILambdaRuntimeService {
  public readonly functionName: string | undefined = process.env.AWS_LAMBDA_FUNCTION_NAME;
  public readonly functionVersion: string | undefined = process.env.AWS_LAMBDA_FUNCTION_VERSION;

  private lambda: LambdaClient = new LambdaClient(this.environment);

  constructor(
    private environment: Environment,
    private image: LambdaImageService
  ) {}

  get log(): Logger {
    return this.environment.log;
  }

  createContainer = async (req: CRI.CreateContainerRequest): Promise<CRI.CreateContainerResponse> => {
    // const { items: sandboxes } = await this.listPodSandbox({ $typeName: 'runtime.v1.ListPodSandboxRequest' });
    // const { podSandboxId } = req;

    const { imageRef } = await this.image.pullImage({
      $typeName: 'runtime.v1.PullImageRequest',
      image: req.config?.image,
      sandboxConfig: req.sandboxConfig,
    });

    return {
      $typeName: 'runtime.v1.CreateContainerResponse',
      containerId: `todo: ${imageRef}`,
    };
  };

  listPodSandbox = async (_req: CRI.ListPodSandboxRequest): Promise<CRI.ListPodSandboxResponse> => {
    const list = (marker?: string) =>
      defer(() => this.lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 10 })));

    const items = await lastValueFrom(
      list().pipe(
        expand((page) => (page.NextMarker ? list(page.NextMarker) : EMPTY)),
        concatMap((page) => page.Functions ?? []),
        filter((fn) => fn.PackageType === 'Image'),
        map(
          (fn): CRI.PodSandbox => ({
            $typeName: 'runtime.v1.PodSandbox',
            id: fn.FunctionName ?? 'unknown',
            labels: {
              runtime: 'TODO',
              architecture: fn.Architectures?.[0] ?? 'unknown',
              memory: fn.MemorySize?.toString() ?? 'unknown',
            },
            annotations: {
              'aws.lambda.arn': fn.FunctionArn ?? '',
              'aws.lambda.version': fn.Version ?? '',
              'aws.lambda.lastModified': fn.LastModified ?? '',
              'aws.lambda.role': fn.Role ?? '',
              'aws.lambda.timeout': fn.Timeout?.toString() ?? '',
              'aws.lambda.codeSha256': fn.CodeSha256 ?? '',
              'aws.lambda.revisionId': fn.RevisionId ?? '',
              'aws.lambda.lastUpdateStatus': fn.LastUpdateStatus ?? '',
              'aws.lambda.lastUpdateStatusReason': fn.LastUpdateStatusReason ?? '',
            },
            createdAt: BigInt(fn.LastModified ? new Date(fn.LastModified).getTime() : Date.now()),
            runtimeHandler: 'TODO',
            state:
              !fn.LastUpdateStatus || fn.LastUpdateStatus !== 'Successful'
                ? CRI.PodSandboxState.SANDBOX_READY
                : CRI.PodSandboxState.SANDBOX_NOTREADY,
          })
        ),
        toArray()
      )
    );

    return {
      $typeName: 'runtime.v1.ListPodSandboxResponse',
      items,
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
