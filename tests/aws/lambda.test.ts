import { Logger, Environment } from '@scaffoldly/rowdy';
import { LambdaRuntimeService } from '../../src/aws/lambda/runtime';
import { LambdaImageService } from '../../src/aws/lambda/image';
import { ANNOTATIONS, ConfigFactory, LABELS } from '../../src/aws/lambda/config';

describe('aws lambda', () => {
  const logger = new Logger();
  const aws = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? it : it.skip;
  const environment = new Environment(logger);
  const service = new LambdaRuntimeService(environment, new LambdaImageService(environment));

  aws(
    'pod lifecycle',
    async () => {
      const factory = ConfigFactory.new().withImage('ubuntu');

      const { podSandboxId } = await service.runPodSandbox({
        $typeName: 'runtime.v1.RunPodSandboxRequest',
        runtimeHandler: '',
        config: factory.SandboxConfig,
      });
      expect(podSandboxId).toBeDefined();
      const [sandbox] = (
        await service.listPodSandbox({
          $typeName: 'runtime.v1.ListPodSandboxRequest',
          filter: { $typeName: 'runtime.v1.PodSandboxFilter', id: podSandboxId, labelSelector: {} },
        })
      ).items;

      expect(sandbox).toBeDefined();
      expect(sandbox!.id).toEqual(podSandboxId);
      expect(Object.keys(sandbox!.labels!).sort()).toEqual(Object.values(LABELS).sort());
      expect(sandbox!.labels![LABELS.ROWDY_IMAGE]).toEqual('ubuntu');
      expect(Object.keys(sandbox!.annotations!).sort()).toEqual(Object.values(ANNOTATIONS).sort());
      expect(sandbox!.annotations![ANNOTATIONS.ROWDY_IMAGE_REF]).toMatch(
        /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/ubuntu@sha256:[a-f0-9]{64}$/
      );

      const { containerId } = await service.createContainer({
        $typeName: 'runtime.v1.CreateContainerRequest',
        podSandboxId: sandbox!.id,
      });
      expect(containerId).toBeDefined();
      const [container] = (
        await service.listContainers({
          $typeName: 'runtime.v1.ListContainersRequest',
          filter: {
            $typeName: 'runtime.v1.ContainerFilter',
            id: containerId,
            podSandboxId: sandbox!.id,
            labelSelector: {},
          },
        })
      ).containers;

      expect(container).toBeDefined();
      expect(container!.id).toMatch(/^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:[a-zA-Z0-9-_]+:[a-f0-9]{12}$/);
      expect(container!.podSandboxId).toEqual(sandbox!.id);
      expect(Object.keys(container!.labels!).sort()).toEqual(Object.values(LABELS).sort());
      expect(container!.labels![LABELS.ROWDY_IMAGE]).toEqual('ubuntu');
      expect(Object.keys(container!.annotations!).sort()).toEqual(Object.values(ANNOTATIONS).sort());
      expect(container!.annotations![ANNOTATIONS.ROWDY_IMAGE_REF]).toMatch(
        /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/ubuntu@sha256:[a-f0-9]{64}$/
      );

      // TODO: ensure image can't be changed, only tag
      // TODO: make alias the same as image tag
      // TODO: update memory
      // TODO: update sha
      // TODO: change image
      // TODO: update env
      // TODO: update entrypoint
      // TODO: add HTTP
      // TODO: delete container
      // TODO: delete sandbox

      // Features TODO:
      // - invokeFunction in AWS console: JSON payload is set as stdin
      // - exec/execSync: run command in function container
    },
    60000
  );
});
