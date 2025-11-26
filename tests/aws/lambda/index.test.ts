import { Logger, Environment } from '@scaffoldly/rowdy';
// import { LambdaRuntimeService } from '../../src/aws/lambda/runtime';
import { LambdaImageService } from '../../../src/aws/lambda/image';
// import { ANNOTATIONS, ConfigFactory, LABELS } from '../../src/aws/lambda/config';
import { LambdaFunction } from '../../../src/aws/lambda/index';
import { inspect } from 'util';
import { lastValueFrom } from 'rxjs';

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
          expect(fn.State.RoleName).toBe('library+python@rowdy.run');
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
