import { Logger, Environment } from '@scaffoldly/rowdy';
import { ConfigFactory } from '../../src/aws/lambda/function';
import { LambdaRuntimeService } from '../../src/aws/lambda/runtime';
import { LambdaImageService } from '../../src/aws/lambda/image';

describe('aws lambda', () => {
  const logger = new Logger();
  const aws = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? it : it.skip;
  const environment = new Environment(logger);
  const service = new LambdaRuntimeService(environment, new LambdaImageService(environment));

  aws(
    'should run a pod sandbox',
    async () => {
      const response = await service.runPodSandbox({
        $typeName: 'runtime.v1.RunPodSandboxRequest',
        runtimeHandler: '',
        config: ConfigFactory.new().withImage('alpine').SandboxConfig,
      });
      expect(response.podSandboxId).toMatch(/^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:alpine_ARO[0-9A-Z]{18}$/);
    },
    60000
  );

  aws(
    'should set memory',
    async () => {
      const response = await service.runPodSandbox({
        $typeName: 'runtime.v1.RunPodSandboxRequest',
        runtimeHandler: '',
        config: ConfigFactory.new().withImage('alpine').withMemory(512).SandboxConfig,
      });
      expect(response.podSandboxId).toMatch(/^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:alpine_ARO[0-9A-Z]{18}$/);
    },
    60000
  );
});
