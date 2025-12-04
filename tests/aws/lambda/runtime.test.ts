import { Logger, Environment } from '@scaffoldly/rowdy';
import { LambdaImageService } from '../../../src/aws/lambda/image';
import { LambdaRuntimeService } from '../../../src/aws/lambda/runtime';
import { CRI } from '@scaffoldly/rowdy-grpc';

describe('aws lambda runtime', () => {
  const logger = new Logger();
  const aws = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? it : it.skip;
  const environment = new Environment(logger);
  const imageService = new LambdaImageService(environment);
  const runtimeService = new LambdaRuntimeService(environment, imageService);

  describe('container lifecycle', () => {
    // TODO: test bad values

    aws(
      'should create and delete a container',
      async () => {
        const name = 'container-lifecycle';
        const imageName = 'python';
        const tag = '3-slim';
        const image = `${imageName}:${tag}`;
        const memory = 1024;
        const command = ['python3'];
        const args = ['-m', 'http.server', '8080'];
        const envs = {
          TEST_ENV: 'hello world',
        };
        const labels = {
          'random-id': crypto.randomUUID(),
        };
        const workingDir = '/tmp';

        const create: CRI.CreateContainerRequest = {
          $typeName: 'runtime.v1.CreateContainerRequest',
          podSandboxId: '', // todo: implement
          config: {
            $typeName: 'runtime.v1.ContainerConfig',
            metadata: {
              $typeName: 'runtime.v1.ContainerMetadata',
              name,
              attempt: 0,
            },
            image: {
              $typeName: 'runtime.v1.ImageSpec',
              annotations: {},
              image,
              runtimeHandler: '',
              userSpecifiedImage: '',
            },
            linux: {
              $typeName: 'runtime.v1.LinuxContainerConfig',
              resources: {
                $typeName: 'runtime.v1.LinuxContainerResources',
                cpuPeriod: 0n,
                cpuQuota: 0n,
                cpusetCpus: '',
                cpusetMems: '',
                cpuShares: 0n,
                hugepageLimits: [],
                memoryLimitInBytes: BigInt(memory) * 1024n * 1024n,
                memorySwapLimitInBytes: 0n,
                oomScoreAdj: 0n,
                unified: {},
              },
            },
            command,
            args,
            envs: Object.entries(envs).map(([key, value]) => ({
              $typeName: 'runtime.v1.KeyValue',
              key,
              value,
            })),
            labels,
            workingDir,
            annotations: {},
            CDIDevices: [],
            devices: [],
            logPath: '',
            mounts: [],
            stdin: false,
            stdinOnce: false,
            stopSignal: CRI.Signal.RUNTIME_DEFAULT,
            tty: false,
          },
        };

        // Initial create
        const { containerId } = await runtimeService.createContainer(create);
        expect(containerId).toMatch(RegExp(`^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:${name}:${tag}$`));

        const listById: CRI.ListContainersRequest = {
          $typeName: 'runtime.v1.ListContainersRequest',
          filter: {
            $typeName: 'runtime.v1.ContainerFilter',
            podSandboxId: '', // todo: implement
            id: containerId,
            labelSelector: {},
          },
        };

        const listByLabels: CRI.ListContainersRequest = {
          $typeName: 'runtime.v1.ListContainersRequest',
          filter: {
            $typeName: 'runtime.v1.ContainerFilter',
            podSandboxId: '', // todo: implement
            id: '',
            labelSelector: labels,
          },
        };

        // Initial assertion
        const { containers } = await runtimeService.listContainers(listById);
        expect(containers.length).toBe(1);
        expect(containers[0]!.id).toBe(containerId);
        expect(containers[0]!.imageRef).toMatch(
          /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/python@sha256:[a-f0-9]{64}$/
        );
        expect(containers[0]!.metadata!.name).toBe(name);
        expect(containers[0]!.annotations['com.amazonaws.lambda.State']).toBe('Active');
        expect(containers[0]!.annotations['com.amazonaws.lambda.MemorySize']).toBe(memory.toString());
        expect(containers[0]!.annotations['com.amazonaws.lambda.Version']).not.toBe('$LATEST');
        expect(containers[0]!.annotations['com.amazonaws.lambda.CodeSha256']).toEqual(
          containers[0]!.imageRef.split('@sha256:')[1]
        );
        expect(containers[0]!.annotations['com.amazonaws.lambda.ImageConfigResponse']).toBe(
          `{"ImageConfig":{"Command":["${command}","${args.join('","')}"],"EntryPoint":["rowdy","--"]}}`
        );
        expect(containers[0]!.labels['random-id']).toEqual(labels['random-id']);
        expect(containers[0]!.labels['run.rowdy.user.agent']).toBeDefined();
        expect(containers[0]!.labels['run.rowdy.image.name']).toBe(imageName);
        expect(containers[0]!.labels['run.rowdy.image.digest']).toBeUndefined();
        expect(containers[0]!.labels['run.rowdy.image.namespace']).toBe('library');
        expect(containers[0]!.labels['run.rowdy.image.registry']).toBe('mirror.gcr.io');

        // List by labels
        expect(await runtimeService.listContainers(listByLabels).then(({ containers }) => containers)).toEqual(
          containers
        );

        // Idempotent create
        expect(
          await runtimeService
            .createContainer(create)
            .then(() => runtimeService.listContainers(listById))
            .then(({ containers }) => containers)
        ).toEqual(containers);

        // TODO Invoke URL

        await runtimeService.removeContainer({ $typeName: 'runtime.v1.RemoveContainerRequest', containerId });

        expect(await runtimeService.listContainers(listById)).toEqual({
          $typeName: 'runtime.v1.ListContainersResponse',
          containers: [],
        });

        expect(await runtimeService.listContainers(listByLabels)).toEqual({
          $typeName: 'runtime.v1.ListContainersResponse',
          containers: [],
        });
      },
      120_000
    );
  });
});
