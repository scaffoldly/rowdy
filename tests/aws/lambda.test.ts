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
    'should run an alpine sandbox',
    async () => {
      const { podSandboxId } = await service.runPodSandbox({
        $typeName: 'runtime.v1.RunPodSandboxRequest',
        runtimeHandler: '',
        config: ConfigFactory.new().withImage('alpine').SandboxConfig,
      });

      expect(podSandboxId).toMatch(/^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:alpine_ARO[0-9A-Z]{18}$/);

      const [sandbox] = (
        await service.listPodSandbox({
          $typeName: 'runtime.v1.ListPodSandboxRequest',
          filter: { $typeName: 'runtime.v1.PodSandboxFilter', id: podSandboxId, labelSelector: {} },
        })
      ).items;

      expect(sandbox!.id).toEqual(podSandboxId);

      expect(Object.keys(sandbox!.labels!).sort()).toEqual(Object.values(LABELS).sort());
      expect(sandbox!.labels![LABELS.ROWDY_IMAGE]).toEqual('alpine');

      expect(Object.keys(sandbox!.annotations!).sort()).toEqual(Object.values(ANNOTATIONS).sort());
      expect(sandbox!.annotations![ANNOTATIONS.ROWDY_IMAGE_REF]).toMatch(
        /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/alpine@sha256:[a-f0-9]{64}$/
      );
    },
    60000
  );

  aws(
    'should set memory',
    async () => {
      const { podSandboxId } = await service.runPodSandbox({
        $typeName: 'runtime.v1.RunPodSandboxRequest',
        runtimeHandler: '',
        config: ConfigFactory.new().withMemory(512).SandboxConfig,
      });

      const [sandbox] = (
        await service.listPodSandbox({
          $typeName: 'runtime.v1.ListPodSandboxRequest',
          filter: { $typeName: 'runtime.v1.PodSandboxFilter', id: podSandboxId, labelSelector: {} },
        })
      ).items;

      expect(sandbox!.labels![LABELS.LAMBDA_MEMORY]).toEqual('512');
    },
    60000
  );

  aws(
    'should create an ubuntu container',
    async () => {
      const factory = ConfigFactory.new().withImage('ubuntu');

      const { podSandboxId } = await service.runPodSandbox({
        $typeName: 'runtime.v1.RunPodSandboxRequest',
        runtimeHandler: '',
        config: factory.SandboxConfig,
      });

      const [sandbox] = (
        await service.listPodSandbox({
          $typeName: 'runtime.v1.ListPodSandboxRequest',
          filter: { $typeName: 'runtime.v1.PodSandboxFilter', id: podSandboxId, labelSelector: {} },
        })
      ).items;
      expect(sandbox).toBeDefined();

      const { containerId } = await service.createContainer({
        $typeName: 'runtime.v1.CreateContainerRequest',
        podSandboxId: sandbox!.id,
      });
      expect(containerId).toBeDefined();
    },
    60000
  );
});
