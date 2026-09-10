import { Logger, Environment, Routes } from '@scaffoldly/rowdy';
import { LambdaImageService } from '../../../src/aws/lambda/image';
import { LambdaFunction } from '../../../src/aws/lambda/index';
import { inspect } from 'util';
import { lastValueFrom } from 'rxjs';
import { Statement } from 'aws-lambda';

describe('aws lambda', () => {
  const logger = new Logger();
  const aws = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? it : it.skip;
  const environment = new Environment(logger);
  const imageService = new LambdaImageService(environment);
  // const runtimeService = new LambdaRuntimeService(environment, imageService);

  describe('lambda function', () => {
    // TODO: scaffoldly/scratch:latest for default image
    describe('sandbox lifecycle', () => {
      aws(
        'should create and delete a minimal sandbox',
        async () => {
          let fn = new LambdaFunction('Sandbox', imageService);

          fn = await new Promise<LambdaFunction>((resolve, reject) => {
            logger.info('Creating function...');
            fn.observe().subscribe({
              next: ({ State }) => logger.info(`State updated: ${inspect(State)}`),
              error: reject,
              complete: () => {
                logger.info('Function created');
                return resolve(fn);
              },
            });
          });

          expect(fn.State).toBeDefined();
          expect(fn.State.RoleName).toBe('scaffoldly+rowdy@rowdy.run');
          expect(fn.State.RoleArn).toMatch(/^arn:aws:iam::[0-9]{12}:role\/scaffoldly\+rowdy@rowdy\.run$/);
          expect(fn.State.RoleId).toMatch(/^ARO[A-Z0-9]{18}$/);
          expect(fn.State.Qualifier).toBe('$LATEST');
          expect(fn.State.FunctionArn).toMatch(/^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:ARO[A-Z0-9]{18}$/);
          expect(fn.State.ImageUri).toMatch(
            /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/scaffoldly\/rowdy@sha256:[a-f0-9]{64}$/
          );
          expect(fn.State.AliasArn).toBeUndefined();
          expect(fn.State.FunctionUrl).toBeUndefined();
          expect(fn.State.FunctionVersion).toBeUndefined();

          fn = await new Promise<LambdaFunction>((resolve, reject) => {
            logger.info('Deleting function...');
            fn.delete().subscribe({
              next: ({ State }) => logger.info(`State updated: ${inspect(State)}`),
              error: reject,
              complete: () => resolve(fn),
            });
          });

          expect(fn.State).toEqual({});
        },
        60_000
      );
    });

    describe('container lifecycle', () => {
      // TODO: withName() option on LambdaFunction to manage function name
      aws('should change memory', async () => {}); // TODO
      aws('should update image', async () => {}); // TODO
      aws('should update environment', async () => {}); // TODO
      aws('idempotent updates', async () => {}); // TODO
      aws(
        'should create and delete a ubuntu container',
        async () => {
          let fn = new LambdaFunction('Container', imageService).withImage('ubuntu:noble-20251001');

          fn = await new Promise<LambdaFunction>((resolve, reject) => {
            logger.info('Creating function...');
            fn.observe().subscribe({
              next: ({ State }) => logger.info(`State updated: ${inspect(State)}`),
              error: reject,
              complete: () => {
                logger.info('Function created');
                return resolve(fn);
              },
            });
          });

          expect(fn.State).toBeDefined();
          expect(fn.State.RoleName).toBe('library+ubuntu@rowdy.run');
          expect(fn.State.RoleArn).toMatch(/^arn:aws:iam::[0-9]{12}:role\/library\+ubuntu@rowdy\.run$/);
          expect(fn.State.RoleId).toMatch(/^ARO[A-Z0-9]{18}$/);
          expect(fn.State.Qualifier).toBe('noble-20251001');
          expect(fn.State.FunctionArn).toMatch(/^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:ARO[A-Z0-9]{18}$/);
          expect(fn.State.ImageUri).toMatch(
            /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/ubuntu@sha256:[a-f0-9]{64}$/
          );
          expect(fn.State.AliasArn).toMatch(
            /^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:ARO[A-Z0-9]{18}:noble-20251001$/
          );
          expect(fn.State.FunctionUrl).toMatch(/^https:\/\/[a-z0-9-]+\.lambda-url\.[a-z0-9-]+\.on\.aws\/$/);
          expect(fn.State.FunctionVersion).not.toBe('$LATEST');

          fn = await new Promise<LambdaFunction>((resolve, reject) => {
            logger.info('Deleting function...');
            fn.delete().subscribe({
              next: ({ State }) => logger.info(`State updated: ${inspect(State)}`),
              error: reject,
              complete: () => resolve(fn),
            });
          });

          expect(fn.State).toEqual({});
        },
        120_000
      );

      aws(
        'should change container memory',
        async () => {
          // Create with 256
          let fn = new LambdaFunction('Container', imageService).withMemory(256).withName('custom-memory');
          fn = await lastValueFrom(fn.observe());
          expect(fn.Status.Configuration?.MemorySize).toBe(256);

          // Update to 128
          fn = await lastValueFrom(fn.withMemory(128).observe());
          expect(fn.Status.Configuration?.MemorySize).toBe(128);

          // Update to 256
          fn = await lastValueFrom(fn.withMemory(256).observe());
          expect(fn.Status.Configuration?.MemorySize).toBe(256);

          // Cleanup
          fn = await lastValueFrom(fn.delete());
          expect(fn.Status?.Configuration?.MemorySize).toBeUndefined();
        },
        120_000
      );

      aws(
        'should serve python3 http server',
        async () => {
          let fn = new LambdaFunction('Container', imageService)
            .withName('python3-http')
            .withImage('python:3-slim')
            .withMemory(256)
            .withCommand('python3 -m http.server 8080')
            .withRoute('{/*path}', 'http://localhost:8080/*path');

          fn = await lastValueFrom(fn.observe());

          // State
          expect(fn.State.RoleName).toBe('library+python@python3-http.rowdy.run');
          expect(fn.State.ImageUri).toMatch(
            /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/python@sha256:[a-f0-9]{64}$/
          );
          expect(fn.State.Qualifier).toBe('3-slim');
          expect(fn.State.FunctionUrl).toMatch(/^https:\/\/[a-z0-9-]+\.lambda-url\.[a-z0-9-]+\.on\.aws\/$/);

          // Status
          expect(fn.Status.Configuration?.MemorySize).toBe(256);
          expect(fn.Status.Configuration?.ImageConfigResponse?.ImageConfig?.EntryPoint).toEqual(['rowdy', '--']);
          expect(fn.Status.Configuration?.ImageConfigResponse?.ImageConfig?.Command).toEqual([
            'python3',
            '-m',
            'http.server',
            '8080',
          ]);
        },
        120_000
      );
    });
  });
});

describe('aws lambda schedules', () => {
  const logger = new Logger();
  const environment = new Environment(logger);
  const imageService = new LambdaImageService(environment);

  const CRON_LINE = '*/15 * * * * POST https://localhost:3000/tunnel/gc';
  const FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:AROAEXAMPLEEXAMPLE12';
  const ALIAS_ARN = `${FUNCTION_ARN}:latest`;
  const ROLE_ARN = 'arn:aws:iam::123456789012:role/library+ubuntu@rowdy.run';

  type SentCommand = { name: string; input: Record<string, unknown> };

  const withCrontab = (...lines: string[]): LambdaFunction => {
    const fn = new LambdaFunction('Container', imageService).withImage('ubuntu:noble-20251001');
    if (lines.length) {
      fn.withRoutes(Routes.empty().withCrontab(lines));
    }
    return fn;
  };

  const mockScheduler = (fn: LambdaFunction, existing: { Name?: string }[] = []): SentCommand[] => {
    const sent: SentCommand[] = [];
    const send = (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'ListSchedulesCommand') {
        return Promise.resolve({ Schedules: existing, $metadata: {} });
      }
      return Promise.resolve({ $metadata: {} });
    };
    (fn['scheduler'] as unknown as { send: typeof send }).send = send;
    return sent;
  };

  const reconcile = async (fn: LambdaFunction, existing: { Name?: string }[] = []): Promise<SentCommand[]> => {
    const sent = mockScheduler(fn, existing);
    await lastValueFrom(fn['reconcileSchedules'](FUNCTION_ARN, ALIAS_ARN, ROLE_ARN, {}), { defaultValue: null });
    return sent;
  };

  describe('reconciliation', () => {
    it('should create the group and one schedule per line', async () => {
      const sent = await reconcile(withCrontab(CRON_LINE));

      expect(sent.map(({ name }) => name)).toEqual([
        'CreateScheduleGroupCommand',
        'ListSchedulesCommand',
        'UpdateScheduleCommand',
      ]);

      const group = sent[0]!.input;
      expect(group.Name).toBe('AROAEXAMPLEEXAMPLE12');

      const schedule = sent[2]!.input;
      expect(schedule.GroupName).toBe('AROAEXAMPLEEXAMPLE12');
      expect(schedule.Name).toMatch(/^[a-f0-9]{16}$/);
      expect(schedule.Description).toBe(CRON_LINE);
      expect(schedule.ScheduleExpression).toBe('cron(*/15 * * * ? *)');
      expect(schedule.ScheduleExpressionTimezone).toBe('UTC');
      expect(schedule.FlexibleTimeWindow).toEqual({ Mode: 'OFF' });
      expect(schedule.Target).toEqual({
        Arn: ALIAS_ARN,
        RoleArn: ROLE_ARN,
        Input: JSON.stringify({
          apiVersion: 'rowdy.run/v1alpha1',
          kind: 'Cron',
          spec: { line: CRON_LINE },
        }),
        RetryPolicy: { MaximumRetryAttempts: 0 },
      });
    });

    it('should name schedules by content so an edited line replaces the old one', async () => {
      const before = await reconcile(withCrontab(CRON_LINE));
      const stale = before[2]!.input.Name as string;

      const after = await reconcile(withCrontab('*/30 * * * * POST https://localhost:3000/tunnel/gc'), [
        { Name: stale },
      ]);

      expect(after.map(({ name }) => name)).toEqual([
        'CreateScheduleGroupCommand',
        'ListSchedulesCommand',
        'DeleteScheduleCommand',
        'UpdateScheduleCommand',
      ]);
      expect(after[2]!.input.Name).toBe(stale);
      expect(after[3]!.input.Name).not.toBe(stale);
    });

    it('should leave a declared schedule in place', async () => {
      const before = await reconcile(withCrontab(CRON_LINE));
      const existing = before[2]!.input.Name as string;

      const after = await reconcile(withCrontab(CRON_LINE), [{ Name: existing }]);

      expect(after.map(({ name }) => name)).toEqual([
        'CreateScheduleGroupCommand',
        'ListSchedulesCommand',
        'UpdateScheduleCommand',
      ]);
    });

    it('should delete the group when the crontab is empty', async () => {
      const sent = await reconcile(withCrontab());

      expect(sent.map(({ name }) => name)).toEqual(['DeleteScheduleGroupCommand']);
      expect(sent[0]!.input.Name).toBe('AROAEXAMPLEEXAMPLE12');
    });
  });

  describe('iam', () => {
    const statements = (document: { Statement: Statement[] }): Record<string, unknown>[] =>
      document.Statement as unknown as Record<string, unknown>[];

    it('should trust the scheduler only when the crontab is non-empty', () => {
      expect(statements(withCrontab()['AssumeRolePolicyDocument'])).toEqual([
        { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
      ]);

      expect(statements(withCrontab(CRON_LINE)['AssumeRolePolicyDocument'])).toEqual([
        { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        { Effect: 'Allow', Principal: { Service: 'scheduler.amazonaws.com' }, Action: 'sts:AssumeRole' },
      ]);
    });

    it('should allow self-invocation only when the crontab is non-empty', () => {
      const without = withCrontab();
      without.State.FunctionArn = FUNCTION_ARN;
      without.State.Qualifier = 'latest';
      expect(
        statements(without['RolePolicyDocument']).find((s) => s.Action === 'lambda:InvokeFunction')
      ).toBeUndefined();

      const fn = withCrontab(CRON_LINE);
      fn.State.FunctionArn = FUNCTION_ARN;
      fn.State.Qualifier = 'latest';
      expect(statements(fn['RolePolicyDocument']).find((s) => s.Action === 'lambda:InvokeFunction')).toEqual({
        Effect: 'Allow',
        Action: 'lambda:InvokeFunction',
        Resource: [FUNCTION_ARN, ALIAS_ARN],
      });
    });
  });

  describe('validation', () => {
    it('should fail the deploy with the offending line quoted', () => {
      expect(() => withCrontab('0 3 1 * 1 https://localhost:3000/gc')['prepare']()).toThrow(
        "'0 3 1 * 1 https://localhost:3000/gc'"
      );
      expect(() => withCrontab('every 15 minutes https://localhost:3000/gc')['prepare']()).toThrow(
        "'every 15 minutes https://localhost:3000/gc'"
      );
      expect(() => withCrontab(CRON_LINE)['prepare']()).not.toThrow();
    });
  });
});
