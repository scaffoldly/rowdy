import { createHash } from 'crypto';
import { strFromU8, unzipSync } from 'fflate';
import { lastValueFrom } from 'rxjs';
import { Environment, Logger } from '../../../src';
import { MicrovmCompute, POLL } from '../../../src/aws/microvm/compute';
import { HOOKS_PORT } from '../../../src/aws/microvm';
import { ComputeSpec } from '../../../src/sandbox/internal/compute';

const IMAGE_URI = '123456789012.dkr.ecr.us-east-1.amazonaws.com/scaffoldly/sandbox@sha256:abc';
const IMAGE_ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox-box';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/box';
const SPEC: ComputeSpec = {
  image: 'scaffoldly/sandbox',
  name: 'sandbox-box',
  timeout: 60_000,
  memory: 1024,
  env: { A: 'b' },
};

type Sent = { name: string; input: Record<string, unknown> };
type Handler = (input: Record<string, unknown>) => unknown;
type Client = {
  send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown>;
};

const missing = (name: string): Error => Object.assign(new Error('missing'), { name });

describe('aws microvm compute', () => {
  const timing = { ...POLL };
  beforeAll(() => Object.assign(POLL, { delay: 1 }));
  afterAll(() => Object.assign(POLL, timing));
  afterEach(() => jest.restoreAllMocks());

  const setup = (handlers: Record<string, Handler> = {}): { compute: MicrovmCompute; sent: Sent[] } => {
    const compute = new MicrovmCompute(new Environment(new Logger(), {}));
    const sent: Sent[] = [];
    const defaults: Record<string, Handler> = {
      ListBucketsCommand: () => ({ Buckets: [] }),
      CreateBucketCommand: () => ({}),
      HeadObjectCommand: () => Promise.reject(missing('NotFound')),
      PutObjectCommand: () => ({}),
      GetCallerIdentityCommand: () => ({ Account: '123456789012' }),
      UpdateAssumeRolePolicyCommand: () => ({}),
      GetRoleCommand: () => ({ Role: { Arn: ROLE_ARN } }),
      PutRolePolicyCommand: () => ({}),
      GetMicrovmImageCommand: () => Promise.reject(missing('ResourceNotFoundException')),
      CreateMicrovmImageCommand: () => ({ imageVersion: '1.0' }),
      UpdateMicrovmImageCommand: () => ({ imageVersion: '2.0' }),
      GetMicrovmImageVersionCommand: () => ({ state: 'SUCCESSFUL' }),
    };
    const send: Client['send'] = async (command) => {
      const { name } = command.constructor;
      sent.push({ name, input: command.input });
      const handler = handlers[name] ?? defaults[name];
      if (!handler) throw new Error(`unexpected ${name}`);
      return handler(command.input);
    };
    [compute['iam'], compute['microvms'], compute['s3'], compute['sts']].forEach((client) => {
      (client as unknown as Client).send = send;
    });
    jest.spyOn(compute['s3'].config, 'region').mockResolvedValue('us-east-1');
    jest
      .spyOn(compute['images'], 'pullImage')
      .mockResolvedValue({ $typeName: 'runtime.v1.PullImageResponse', imageRef: IMAGE_URI });
    return { compute, sent };
  };

  const input = (sent: Sent[], name: string): Record<string, unknown> => sent.find((s) => s.name === name)!.input;
  const names = (sent: Sent[]): string[] => sent.map(({ name }) => name);
  const dockerfile = (sent: Sent[]): string =>
    strFromU8(unzipSync(input(sent, 'PutObjectCommand').Body as Uint8Array).Dockerfile!);
  const create = (compute: MicrovmCompute): Promise<MicrovmCompute> => lastValueFrom(compute.create(SPEC));

  describe('assert', () => {
    const valid = { timeout: 60_000, memory: 512, env: {} };

    it('allows what AWS allows', () => {
      expect(() => MicrovmCompute.assert({ ...valid, timeout: 28_800_000, memory: 8192 })).not.toThrow();
    });

    it.each([500, 1500, 28_801_000])('refuses a timeout of %d', (timeout) => {
      expect(() => MicrovmCompute.assert({ ...valid, timeout })).toThrow('timeout must be whole seconds');
    });

    it.each([128, 600, 10240])('refuses %d MB', (memory) => {
      expect(() => MicrovmCompute.assert({ ...valid, memory })).toThrow('memory must be one of');
    });

    it('refuses more than 50 env variables', () => {
      const env = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`K${i}`, 'v']));

      expect(() => MicrovmCompute.assert({ ...valid, env })).toThrow('at most 50');
    });
  });

  describe('create', () => {
    it('resolves with the image as the sandbox', async () => {
      const { compute } = setup();

      await create(compute);

      expect(compute.sandboxId).toBe(IMAGE_ARN);
    });

    it('builds FROM the image in ECR with rowdy as the entrypoint', async () => {
      const { compute, sent } = setup();

      await create(compute);

      expect(dockerfile(sent)).toBe(`FROM ${IMAGE_URI}\nENTRYPOINT ["/usr/local/bin/rowdy"]\n`);
      expect(compute['images']['_layersFrom']).toContain('ghcr.io/scaffoldly/rowdy:beta');
    });

    it('keeps the zip in a folder for the sandbox', async () => {
      const { compute, sent } = setup();

      await create(compute);

      expect(input(sent, 'PutObjectCommand')).toMatchObject({ Key: 'sandbox-box/code.zip' });
    });

    it('configures the image', async () => {
      const { compute, sent } = setup();

      await create(compute);

      const { Bucket } = input(sent, 'PutObjectCommand');
      expect(input(sent, 'CreateMicrovmImageCommand')).toMatchObject({
        name: 'sandbox-box',
        buildRoleArn: ROLE_ARN,
        cpuConfigurations: [{ architecture: 'X86_64' }],
        additionalOsCapabilities: ['ALL'],
        resources: [{ minimumMemoryInMiB: 1024 }],
        environmentVariables: { A: 'b' },
        hooks: { port: HOOKS_PORT },
        codeArtifact: { uri: `s3://${Bucket}/sandbox-box/code.zip` },
      });
    });

    it('zips the same bytes every time', async () => {
      const [a, b] = [setup(), setup()];

      await create(a.compute);
      await create(b.compute);

      expect(input(a.sent, 'PutObjectCommand').Body).toEqual(input(b.sent, 'PutObjectCommand').Body);
    });

    it('starts no VM', async () => {
      const { compute, sent } = setup();

      await create(compute);

      expect(names(sent).filter((name) => /Run|Microvm$/.test(name))).toEqual([]);
    });

    const md5 = async (): Promise<string> => {
      const { compute, sent } = setup();
      await create(compute);
      const body = input(sent, 'PutObjectCommand').Body as Uint8Array;
      return `"${createHash('md5').update(body).digest('hex')}"`;
    };

    it.each(['CREATE_FAILED', 'UPDATE_FAILED'])('rebuilds an image in %s from the same Dockerfile', async (state) => {
      const ETag = await md5();
      const { compute, sent } = setup({
        GetMicrovmImageCommand: () => ({ state, latestActiveImageVersion: '1.0' }),
        HeadObjectCommand: () => ({ ETag }),
      });

      await create(compute);

      expect(names(sent)).toContain('UpdateMicrovmImageCommand');
      expect(names(sent)).not.toContain('CreateMicrovmImageCommand');
    });

    it('reuses an image built from the same Dockerfile', async () => {
      const ETag = await md5();
      const { compute, sent } = setup({
        GetMicrovmImageCommand: () => ({ state: 'CREATED', latestActiveImageVersion: '1.0' }),
        HeadObjectCommand: () => ({ ETag }),
      });

      await create(compute);

      expect(names(sent)).not.toContain('PutObjectCommand');
      expect(names(sent)).not.toContain('CreateMicrovmImageCommand');
      expect(names(sent)).not.toContain('UpdateMicrovmImageCommand');
    });

    it('updates an image whose Dockerfile changed', async () => {
      const { compute, sent } = setup({
        GetMicrovmImageCommand: () => ({ state: 'UPDATED', latestActiveImageVersion: '1.0' }),
        HeadObjectCommand: () => ({ ETag: '"stale"' }),
      });

      await create(compute);

      const update = input(sent, 'UpdateMicrovmImageCommand');
      expect(update).toMatchObject({ imageIdentifier: IMAGE_ARN, buildRoleArn: ROLE_ARN });
      expect(update).not.toHaveProperty('name');
      expect(update).not.toHaveProperty('tags');
    });

    it('waits for a build already running', async () => {
      const states = ['CREATING', 'CREATED'];
      const { compute, sent } = setup({
        GetMicrovmImageCommand: () => ({ state: states.shift(), latestActiveImageVersion: '1.0' }),
      });

      await create(compute);

      expect(names(sent).filter((name) => name === 'GetMicrovmImageCommand')).toHaveLength(2);
    });

    it('waits for the build', async () => {
      const states = ['PENDING', 'IN_PROGRESS', 'SUCCESSFUL'];
      const { compute, sent } = setup({ GetMicrovmImageVersionCommand: () => ({ state: states.shift() }) });

      await create(compute);

      expect(names(sent).filter((name) => name === 'GetMicrovmImageVersionCommand')).toHaveLength(3);
    });

    it('rejects with why a build failed', async () => {
      const { compute } = setup({
        GetMicrovmImageVersionCommand: () => ({ state: 'FAILED', stateReason: 'The container image build failed.' }),
      });

      await expect(create(compute)).rejects.toThrow(
        'Sandbox sandbox-box failed to build: The container image build failed.'
      );
    });

    it('retries a role that is still propagating', async () => {
      const errors = [Object.assign(new Error('denied'), { name: 'AccessDeniedException' })];
      const { compute, sent } = setup({
        CreateMicrovmImageCommand: () => {
          const error = errors.shift();
          if (error) throw error;
          return { imageVersion: '1.0' };
        },
      });

      await create(compute);

      expect(names(sent).filter((name) => name === 'CreateMicrovmImageCommand')).toHaveLength(2);
    });

    it('creates a role only AWS can assume, with no wider S3 access than the zip', async () => {
      const { compute, sent } = setup({
        UpdateAssumeRolePolicyCommand: (() => {
          let exists = false;
          return () => {
            if (exists) return {};
            exists = true;
            throw missing('NoSuchEntityException');
          };
        })(),
        CreateRoleCommand: () => ({}),
      });

      await create(compute);

      const {
        Statement: [trust],
      } = JSON.parse(`${input(sent, 'CreateRoleCommand').AssumeRolePolicyDocument}`);
      expect(trust).toMatchObject({
        Principal: { Service: 'lambda.amazonaws.com' },
        Action: ['sts:AssumeRole', 'sts:TagSession'],
      });
      const { Bucket } = input(sent, 'PutObjectCommand');
      const { Statement } = JSON.parse(`${input(sent, 'PutRolePolicyCommand').PolicyDocument}`);
      expect(Statement[0]).toMatchObject({ Resource: `arn:aws:s3:::${Bucket}/sandbox-box/code.zip` });
      expect(Statement[3]).toMatchObject({
        Action: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
        Resource: 'arn:aws:ecr:us-east-1:123456789012:repository/scaffoldly/sandbox',
      });
    });
  });

  describe('bucket', () => {
    it('creates one with a random name and the owner tag', async () => {
      const { compute, sent } = setup();

      await create(compute);

      const { Bucket, CreateBucketConfiguration } = input(sent, 'CreateBucketCommand');
      expect(Bucket).toMatch(/^rowdy-sandboxes-[0-9a-f]{16}$/);
      expect(CreateBucketConfiguration).toEqual({ Tags: [{ Key: 'rowdy:owner', Value: 'rowdy-sandboxes' }] });
    });

    it('recovers an existing one by its tag', async () => {
      const { compute, sent } = setup({
        ListBucketsCommand: () => ({ Buckets: [{ Name: 'rowdy-sandboxes-a' }, { Name: 'rowdy-sandboxes-b' }] }),
        GetBucketTaggingCommand: ({ Bucket }) => {
          if (Bucket === 'rowdy-sandboxes-a') throw missing('NoSuchTagSet');
          return { TagSet: [{ Key: 'rowdy:owner', Value: 'rowdy-sandboxes' }] };
        },
      });

      await create(compute);

      expect(names(sent)).not.toContain('CreateBucketCommand');
      expect(input(sent, 'PutObjectCommand')).toMatchObject({ Bucket: 'rowdy-sandboxes-b' });
    });

    it('takes the first by name when several match', async () => {
      const { compute, sent } = setup({
        ListBucketsCommand: () => ({ Buckets: [{ Name: 'rowdy-sandboxes-b' }, { Name: 'rowdy-sandboxes-a' }] }),
        GetBucketTaggingCommand: () => ({ TagSet: [{ Key: 'rowdy:owner', Value: 'rowdy-sandboxes' }] }),
      });

      await create(compute);

      expect(input(sent, 'PutObjectCommand')).toMatchObject({ Bucket: 'rowdy-sandboxes-a' });
    });

    it('ignores a bucket owned by something else', async () => {
      const { compute, sent } = setup({
        ListBucketsCommand: () => ({ Buckets: [{ Name: 'rowdy-sandboxes-other' }] }),
        GetBucketTaggingCommand: () => ({ TagSet: [{ Key: 'rowdy:owner', Value: 'other' }] }),
      });

      await create(compute);

      expect(names(sent)).toContain('CreateBucketCommand');
    });

    it('looks only in this region', async () => {
      const { compute, sent } = setup();

      await create(compute);

      expect(input(sent, 'ListBucketsCommand')).toEqual({ Prefix: 'rowdy-sandboxes-', BucketRegion: 'us-east-1' });
    });
  });

  describe('attach', () => {
    it('connects to a sandbox', async () => {
      const { compute } = setup({ ListTagsCommand: () => ({ Tags: { 'run.rowdy.aws': 'microvm' } }) });

      await lastValueFrom(compute.attach(IMAGE_ARN));

      expect(compute.sandboxId).toBe(IMAGE_ARN);
    });

    it('refuses an image that is not one', async () => {
      const { compute } = setup({ ListTagsCommand: () => ({ Tags: {} }) });

      await expect(lastValueFrom(compute.attach(IMAGE_ARN))).rejects.toThrow(`Not a sandbox: ${IMAGE_ARN}`);
    });
  });

  it('has no sandbox before create', () => {
    expect(() => setup().compute.sandboxId).toThrow('Sandbox has no image');
  });

  it('cannot run a command yet', async () => {
    await expect(lastValueFrom(setup().compute.exec({} as never))).rejects.toThrow(
      'runCommand is not implemented on compute microvm'
    );
  });
});
