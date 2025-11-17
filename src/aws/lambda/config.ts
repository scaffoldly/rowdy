import { CRI } from '@scaffoldly/rowdy-grpc';
import { Transfer } from '../../api/internal/transfer';
import { FunctionCodeLocation, FunctionConfiguration, ListTagsResponse } from '@aws-sdk/client-lambda';

export const ANNOTATIONS = {
  LAMBDA_ARN: 'com.amazonaws.lambda.arn',
  LAMBDA_VERSION: 'com.amazonaws.lambda.version',
  LAMBDA_ROLE: 'com.amazonaws.lambda.role',
  LAMBDA_TIMEOUT: 'com.amazonaws.lambda.timeout',
  LAMBDA_CODE_SHA256: 'com.amazonaws.lambda.codeSha256',
  LAMBDA_REVISION_ID: 'com.amazonaws.lambda.revisionId',
  ROWDY_RUNTIME: 'run.rowdy.runtime',
  ROWDY_IMAGE: 'run.rowdy.image',
  ROWDY_IMAGE_REF: 'run.rowdy.image.ref',
};

export const LABELS = {
  LAMBDA_ARCHITECTURE: 'com.amazonaws.lambda.architecture',
  LAMBDA_ENTRYPOINT: 'com.amazonaws.lambda.entrypoint',
  LAMBDA_MEMORY: 'com.amazonaws.lambda.memory',
  LAMBDA_TIMEOUT: 'com.amazonaws.lambda.timeout',
  ROWDY_IMAGE: ANNOTATIONS.ROWDY_IMAGE,
  ROWDY_RUNTIME: ANNOTATIONS.ROWDY_RUNTIME,
};

export class ConfigFactory {
  private _sandboxConfig: CRI.PodSandboxConfig = {
    $typeName: 'runtime.v1.PodSandboxConfig',
    annotations: {
      [`${ANNOTATIONS.ROWDY_IMAGE}`]: 'scaffoldly/rowdy:beta',
      [`${ANNOTATIONS.ROWDY_RUNTIME}`]: 'com.amazonaws.lambda',
    },
    hostname: 'not-implemented',
    labels: {
      [`${LABELS.LAMBDA_MEMORY}`]: '1024',
      [`${LABELS.LAMBDA_TIMEOUT}`]: '900',
      [`${LABELS.ROWDY_RUNTIME}`]: 'com.amazonaws.lambda',
    },
    logDirectory: 'not-implemented',
    metadata: {
      $typeName: 'runtime.v1.PodSandboxMetadata',
      attempt: 0,
      name: 'rowdy',
      namespace: 'not-implemented',
      uid: 'not-implemented',
    },
    portMappings: [],
    linux: {
      $typeName: 'runtime.v1.LinuxPodSandboxConfig',
      cgroupParent: 'not-implemented',
      sysctls: {},
      resources: {
        $typeName: 'runtime.v1.LinuxContainerResources',
        cpuPeriod: BigInt(0),
        cpuQuota: BigInt(0),
        cpuShares: BigInt(0),
        memoryLimitInBytes: BigInt(1024 * 1024 * 1024),
        cpusetCpus: 'not-implemented',
        cpusetMems: 'not-implemented',
        memorySwapLimitInBytes: BigInt(0),
        oomScoreAdj: BigInt(0),
        unified: {},
        hugepageLimits: [],
      },
    },
  };

  private constructor() {}

  static new(): ConfigFactory {
    return new ConfigFactory();
  }

  static fromLambda(
    config?: FunctionConfiguration,
    code?: FunctionCodeLocation,
    tags?: ListTagsResponse
  ): ConfigFactory {
    const factory = new ConfigFactory();
    if (config?.FunctionArn) {
      factory._sandboxConfig.metadata!.name = config.FunctionArn;
    }
    if (config?.Architectures && config.Architectures[0]) {
      factory._sandboxConfig.labels![LABELS.LAMBDA_ARCHITECTURE] = config.Architectures[0];
    }
    if (config?.ImageConfigResponse?.ImageConfig?.EntryPoint?.[0]) {
      factory._sandboxConfig.labels![LABELS.LAMBDA_ENTRYPOINT] = config.ImageConfigResponse.ImageConfig.EntryPoint[0];
    }
    if (config?.MemorySize) {
      factory._sandboxConfig.linux!.resources!.memoryLimitInBytes = BigInt(config.MemorySize * 1024 * 1024);
      factory._sandboxConfig.labels![LABELS.LAMBDA_MEMORY] = config.MemorySize.toString();
    }
    if (config?.Timeout) {
      factory._sandboxConfig.labels![LABELS.LAMBDA_TIMEOUT] = config.Timeout.toString();
    }
    if (code?.ImageUri) {
      const image = Transfer.normalizeImage(code.ImageUri);
      factory._sandboxConfig.metadata!.name = image.name;
      factory._sandboxConfig.labels![LABELS.ROWDY_IMAGE] = image.name;
    }
    if (tags?.Tags) {
      factory._sandboxConfig.annotations = tags.Tags;
    }
    return factory;
  }

  static fromSandboxRequest(req: CRI.RunPodSandboxRequest): ConfigFactory {
    const factory = new ConfigFactory();
    factory._sandboxConfig = { ...factory._sandboxConfig, ...req.config };
    factory._sandboxConfig.metadata = { ...factory._sandboxConfig.metadata!, ...req.config?.metadata };
    factory._sandboxConfig.annotations = {
      ...factory._sandboxConfig.annotations,
      ...req.config?.annotations,
    };
    factory._sandboxConfig.labels = {
      ...factory._sandboxConfig.labels,
      ...req.config?.labels,
    };
    factory._sandboxConfig.linux = { ...factory._sandboxConfig.linux!, ...req.config?.linux };
    factory._sandboxConfig.linux!.resources = {
      ...factory._sandboxConfig.linux!.resources!,
      ...req.config?.linux?.resources,
    };
    return factory;
  }

  static fromContainerRequest(req: CRI.CreateContainerRequest): ConfigFactory {
    const factory = new ConfigFactory();
    factory._sandboxConfig.metadata = { ...factory._sandboxConfig.metadata! };
    factory._sandboxConfig.metadata.name = req.config?.metadata?.name || factory._sandboxConfig.metadata.name;
    factory._sandboxConfig.annotations = {
      ...factory._sandboxConfig.annotations,
      ...req.config?.annotations,
    };
    factory._sandboxConfig.labels = {
      ...factory._sandboxConfig.labels,
      ...req.config?.labels,
    };
    factory._sandboxConfig.linux = { ...factory._sandboxConfig.linux! };
    factory._sandboxConfig.linux!.resources = {
      ...factory._sandboxConfig.linux!.resources!,
      ...req.config?.linux?.resources,
    };
    return factory;
  }

  withImage(image?: string): this {
    if (!image) {
      return this;
    }
    this._sandboxConfig.metadata!.name = Transfer.normalizeImage(image).name;
    this._sandboxConfig.annotations![ANNOTATIONS.ROWDY_IMAGE] = image;
    return this;
  }

  withMemory(megabytes: number = 1024): this {
    this._sandboxConfig.linux!.resources!.memoryLimitInBytes = BigInt(megabytes * 1024 * 1024);
    this._sandboxConfig.labels![LABELS.LAMBDA_MEMORY] = megabytes.toString();
    return this;
  }

  get SandboxConfig(): CRI.PodSandboxConfig {
    return this._sandboxConfig;
  }

  get PullImageResponse(): CRI.PullImageResponse {
    const imageRef = this._sandboxConfig.annotations![ANNOTATIONS.ROWDY_IMAGE_REF];
    if (!imageRef) {
      throw new Error('SandboxConfig is missing required annotation for image reference');
    }
    const pullImageResponse: CRI.PullImageResponse = {
      $typeName: 'runtime.v1.PullImageResponse',
      imageRef,
    };
    return pullImageResponse;
  }

  get ImageSpec(): CRI.ImageSpec {
    const image =
      this._sandboxConfig.annotations![ANNOTATIONS.ROWDY_IMAGE_REF] ||
      this._sandboxConfig.annotations![ANNOTATIONS.ROWDY_IMAGE];

    if (!image) {
      throw new Error('SandboxConfig is missing required annotation for image ref');
    }

    const imageSpec: CRI.ImageSpec = {
      $typeName: 'runtime.v1.ImageSpec',
      annotations: { ...this.SandboxConfig.annotations },
      image,
      runtimeHandler: this.RunPodSandboxRequest.runtimeHandler,
      userSpecifiedImage: 'not-implemented',
    };
    return imageSpec;
  }

  get RunPodSandboxRequest(): CRI.RunPodSandboxRequest {
    const req: CRI.RunPodSandboxRequest = {
      $typeName: 'runtime.v1.RunPodSandboxRequest',
      runtimeHandler: this._sandboxConfig.annotations![ANNOTATIONS.ROWDY_RUNTIME]!,
      config: this.SandboxConfig,
    };
    return req;
  }

  get CreateContainerRequest(): CRI.CreateContainerRequest {
    const req: CRI.CreateContainerRequest = {
      $typeName: 'runtime.v1.CreateContainerRequest',
      sandboxConfig: this.SandboxConfig,
      podSandboxId: this.SandboxConfig.metadata!.name!,
      config: {
        $typeName: 'runtime.v1.ContainerConfig',
        annotations: {},
        args: [],
        CDIDevices: [],
        command: [],
        envs: [],
        devices: [],
        image: this.ImageSpec,
        labels: {},
        logPath: 'not-implemented',
        mounts: [],
        stdin: false,
        stdinOnce: false,
        tty: false,
        stopSignal: CRI.Signal.RUNTIME_DEFAULT,
        workingDir: 'not-implemented',
      },
    };
    return req;
  }

  get RuntimeHandler(): string {
    return this._sandboxConfig.annotations![ANNOTATIONS.ROWDY_RUNTIME]!;
  }
}
