import { createHash } from 'crypto';
import { strFromU8, unzipSync } from 'fflate';
import { lastValueFrom, Observable, of } from 'rxjs';
import { Logger } from '../../../src';
import { SandboxEnvironment } from '../../../src/sandbox/internal/environment';
import { ExecFinished } from '../../../src/api/types';
import { MicrovmCompute, POLL, TERMINATE_POLL } from '../../../src/aws/microvm/compute';
import { EXEC_STREAM, execFrame } from '../../../src/proxy/shell';
import { EXEC_ID_HEADER, EXEC_PATH, FILES_PATH, HOOKS_PORT } from '../../../src/aws/microvm';
import { ComputeSpec } from '../../../src/sandbox/internal/compute';
import { CmdId } from '../../../src/aws/exec';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';

const IMAGE_URI = '123456789012.dkr.ecr.us-east-1.amazonaws.com/scaffoldly/sandbox@sha256:abc';
const IMAGE_ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox-box';
const BASE_ARN = 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1';
const AVAILABLE = { status: 'AVAILABLE', supportedCpuConfigurations: [{ architecture: 'X86_64' }] };
const ROLE_ARN = 'arn:aws:iam::123456789012:role/box';
const SPEC: ComputeSpec = {
  image: 'scaffoldly/sandbox',
  name: 'sandbox-box',
  timeout: 60_000,
  memory: 1024,
  env: { A: 'b' },
  meta: {},
  layersFrom: [],
  wait: true,
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
  beforeAll(() => Object.assign(TERMINATE_POLL, { delay: 1 }));
  afterAll(() => Object.assign(POLL, timing));
  afterEach(() => jest.restoreAllMocks());

  const setup = (
    handlers: Record<string, Handler> = {},
    environment = new SandboxEnvironment(new Logger())
  ): { compute: MicrovmCompute; sent: Sent[] } => {
    const compute = new MicrovmCompute(environment);
    const sent: Sent[] = [];
    const defaults: Record<string, Handler> = {
      ListManagedMicrovmImagesCommand: () => ({ items: [{ imageArn: BASE_ARN, createdAt: new Date(1) }] }),
      ListManagedMicrovmImageVersionsCommand: () => ({ items: [AVAILABLE] }),
      ListBucketsCommand: () => ({ Buckets: [] }),
      CreateBucketCommand: () => ({}),
      HeadObjectCommand: () => Promise.reject(missing('NotFound')),
      PutObjectCommand: () => ({}),
      GetCallerIdentityCommand: () => ({ Account: '123456789012' }),
      CreateLogGroupCommand: () => ({}),
      CreateRoleCommand: () => Promise.reject(missing('EntityAlreadyExistsException')),
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
    const { image } = compute as unknown as { image: Record<'iam' | 'logs' | 'microvms' | 's3' | 'sts', Client> };
    [image.iam, image.logs, image.microvms, image.s3, image.sts, compute['microvms'], compute['sts']].forEach(
      (client) => {
        (client as unknown as Client).send = send;
      }
    );
    jest.spyOn(compute['image']['s3'].config, 'region').mockResolvedValue('us-east-1');
    jest.spyOn(compute['microvms'].config, 'region').mockResolvedValue('us-east-1');
    jest
      .spyOn(compute['environment'].images, 'pullImage')
      .mockReturnValue(of({ Image: 'alpine', ImageUri: IMAGE_URI }));
    return { compute, sent };
  };

  const input = (sent: Sent[], name: string): Record<string, unknown> => sent.find((s) => s.name === name)!.input;
  const names = (sent: Sent[]): string[] => sent.map(({ name }) => name);
  const dockerfile = (sent: Sent[]): string =>
    strFromU8(unzipSync(input(sent, 'PutObjectCommand').Body as Uint8Array).Dockerfile!);
  const create = (compute: MicrovmCompute): Promise<MicrovmCompute> => lastValueFrom(compute.create(SPEC));

  describe('assert', () => {
    const valid = { timeout: 60_000, memory: 512, env: {}, meta: {} };

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

    it.each<Record<string, string>>([{ 'a/b': 'x' }, { k: 'x'.repeat(257) }, { k: 'no#' }])(
      'refuses meta AWS would not tag: %j',
      (meta) => {
        expect(() => MicrovmCompute.assert({ ...valid, meta })).toThrow('meta must be what AWS takes in a tag');
      }
    );
  });

  describe('create', () => {
    it('checks on a build at the pollInterval it was given', async () => {
      const at: number[] = [];
      const { compute } = setup(
        {
          GetMicrovmImageVersionCommand: () => {
            at.push(Date.now());
            return { state: at.length < 2 ? 'BUILDING' : 'SUCCESSFUL' };
          },
        },
        new SandboxEnvironment(new Logger(), { pollInterval: 60 })
      );

      await create(compute);

      expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(50);
    });

    it('resolves with the image as the sandbox', async () => {
      const { compute } = setup();

      await create(compute);

      expect(compute.sandboxId).toBe('sandbox-box');
    });

    it('builds FROM the image in ECR with rowdy as the entrypoint', async () => {
      const { compute, sent } = setup();

      await create(compute);

      expect(dockerfile(sent)).toBe(`FROM ${IMAGE_URI}\nENTRYPOINT ["/usr/local/bin/rowdy"]\n`);
      expect(compute['environment'].images.pullImage).toHaveBeenCalledWith(SPEC.image, {
        layersFrom: ['ghcr.io/scaffoldly/rowdy:beta'],
      });
    });

    it("adds the spec's layers after rowdy's", async () => {
      const { compute } = setup();

      await lastValueFrom(compute.create({ ...SPEC, layersFrom: ['tunneld/tunneld:latest'] }));

      expect(compute['environment'].images.pullImage).toHaveBeenCalledWith(SPEC.image, {
        layersFrom: ['ghcr.io/scaffoldly/rowdy:beta', 'tunneld/tunneld:latest'],
      });
    });

    it('keeps the zip in a folder for the sandbox', async () => {
      const { compute, sent } = setup();

      await create(compute);

      expect(input(sent, 'PutObjectCommand')).toMatchObject({ Key: `sandbox-box/${IMAGE_URI}.zip` });
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
        codeArtifact: { uri: `s3://${Bucket}/sandbox-box/${IMAGE_URI}.zip` },
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

    describe('without waiting', () => {
      const start = (compute: MicrovmCompute): Promise<MicrovmCompute> =>
        lastValueFrom(compute.create({ ...SPEC, wait: false }));

      it('resolves once the build has started, with the sandbox', async () => {
        const { compute, sent } = setup({ GetMicrovmImageVersionCommand: () => ({ state: 'IN_PROGRESS' }) });

        await expect(start(compute)).resolves.toBe(compute);
        expect(compute.sandboxId).toBe('sandbox-box');
        expect(names(sent)).toContain('CreateMicrovmImageCommand');
        expect(names(sent)).not.toContain('GetMicrovmImageVersionCommand');
      });

      it('leaves a build already running to finish', async () => {
        const { compute, sent } = setup({ GetMicrovmImageCommand: () => ({ state: 'CREATING' }) });

        await start(compute);

        expect(names(sent).filter((name) => name === 'GetMicrovmImageCommand')).toHaveLength(1);
        expect(names(sent)).not.toContain('CreateMicrovmImageCommand');
        expect(names(sent)).not.toContain('UpdateMicrovmImageCommand');
      });
    });

    it('rejects with why a build failed', async () => {
      const { compute } = setup({
        GetMicrovmImageVersionCommand: () => ({ state: 'FAILED', stateReason: 'The container image build failed.' }),
      });

      await expect(create(compute)).rejects.toThrow(
        'Sandbox sandbox-box failed to build: The container image build failed.'
      );
    });

    it('makes its role first, so a host allowed only the sandbox path can make one', async () => {
      let created = false;
      // As IAM does for such a host: a role that isn't there is refused, not missing.
      const { compute, sent } = setup({
        CreateRoleCommand: () => {
          created = true;
          return {};
        },
        UpdateAssumeRolePolicyCommand: () => (created ? {} : Promise.reject(missing('AccessDenied'))),
      });

      await expect(create(compute)).resolves.toBe(compute);
      expect(names(sent).indexOf('CreateRoleCommand')).toBeLessThan(
        names(sent).indexOf('UpdateAssumeRolePolicyCommand')
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
      expect(input(sent, 'CreateRoleCommand').Path).toBe('/rowdy/sandbox/');
      expect(trust).toMatchObject({
        Principal: { Service: 'lambda.amazonaws.com' },
        Action: ['sts:AssumeRole', 'sts:TagSession'],
      });
      const { Bucket } = input(sent, 'PutObjectCommand');
      const { Statement } = JSON.parse(`${input(sent, 'PutRolePolicyCommand').PolicyDocument}`);
      expect(Statement[0]).toMatchObject({ Resource: `arn:aws:s3:::${Bucket}/sandbox-box/${IMAGE_URI}.zip` });
      expect(Statement[3]).toMatchObject({
        Action: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
        Resource: 'arn:aws:ecr:us-east-1:123456789012:repository/scaffoldly/sandbox',
      });
    });

    it('makes the log group, and the role writes only to it', async () => {
      const { compute, sent } = setup();

      await create(compute);

      expect(input(sent, 'CreateLogGroupCommand')).toEqual({ logGroupName: '/aws/lambda-microvms/sandbox-box' });
      expect(names(sent).indexOf('CreateLogGroupCommand')).toBeLessThan(
        names(sent).indexOf('CreateMicrovmImageCommand')
      );
      const { Statement } = JSON.parse(`${input(sent, 'PutRolePolicyCommand').PolicyDocument}`);
      expect(Statement[1]).toEqual({
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda-microvms/sandbox-box:*',
      });
    });

    it('is fine with a log group that is there', async () => {
      const { compute, sent } = setup({
        CreateLogGroupCommand: () => Promise.reject(missing('ResourceAlreadyExistsException')),
      });

      await create(compute);

      expect(names(sent)).toContain('CreateMicrovmImageCommand');
    });

    it("rejects when it can't make the log group", async () => {
      const { compute } = setup({ CreateLogGroupCommand: () => Promise.reject(missing('AccessDeniedException')) });

      await expect(create(compute)).rejects.toMatchObject({ name: 'AccessDeniedException' });
    });
  });

  describe('base image', () => {
    const NEWER = 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-2';
    const images = (): { items: unknown[] } => ({
      items: [
        { imageArn: BASE_ARN, createdAt: new Date(1) },
        { imageArn: NEWER, createdAt: new Date(2) },
      ],
    });

    it("uses AWS's newest", async () => {
      const { compute, sent } = setup({ ListManagedMicrovmImagesCommand: images });

      await create(compute);

      expect(input(sent, 'CreateMicrovmImageCommand')).toMatchObject({ baseImageArn: NEWER });
    });

    it.each([
      ['only ARM', { status: 'AVAILABLE', supportedCpuConfigurations: [{ architecture: 'ARM_64' }] }],
      ['expired', { ...AVAILABLE, status: 'EXPIRED' }],
    ])('skips one that is %s', async (_, version) => {
      const { compute, sent } = setup({
        ListManagedMicrovmImagesCommand: images,
        ListManagedMicrovmImageVersionsCommand: ({ imageIdentifier }) => ({
          items: [imageIdentifier === NEWER ? version : AVAILABLE],
        }),
      });

      await create(compute);

      expect(input(sent, 'CreateMicrovmImageCommand')).toMatchObject({ baseImageArn: BASE_ARN });
    });

    it('rejects when none will do', async () => {
      const { compute } = setup({ ListManagedMicrovmImageVersionsCommand: () => ({ items: [] }) });

      await expect(create(compute)).rejects.toThrow('AWS has no base image for X86_64');
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

  describe('output', () => {
    const cmdId = (sandbox = 'sandbox-box') =>
      CmdId.stringify({ sandbox, day: '2026/11/12', version: '1.0', vm: 'microvm-11111111', exec: '66666666' });

    it("reads the stream its cmdId names, in the image's log group", async () => {
      const { compute } = setup({
        GetMicrovmImageCommand: () => ({ latestActiveImageVersion: '1.0' }),
        GetMicrovmImageVersionCommand: () => ({
          logging: { cloudWatch: { logGroup: '/aws/lambda-microvms/sandbox-box' } },
        }),
      });
      compute['image'].withArn(IMAGE_ARN);
      const logs = jest.spyOn(CloudWatchLogsClient.prototype, 'send').mockResolvedValue({ events: [] } as never);

      await lastValueFrom(compute.output(cmdId()));

      expect((logs.mock.calls[0]![0] as { input: unknown }).input).toMatchObject({
        logGroupIdentifier: 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda-microvms/sandbox-box',
        logStreamNamePrefix: '2026/11/12[1.0]microvm-11111111',
        filterPattern: '"rowdy.exec" "66666666"',
      });
    });

    it("refuses another sandbox's cmdId, before reaching AWS", async () => {
      const { compute, sent } = setup();
      compute['image'].withArn(IMAGE_ARN);

      await expect(lastValueFrom(compute.output(cmdId('sandbox-other')))).rejects.toThrow(
        'Not a command in this sandbox.'
      );
      expect(sent).toEqual([]);
    });
  });

  describe('attach', () => {
    it('connects to a sandbox', async () => {
      const { compute } = setup({ ListTagsCommand: () => ({ Tags: { 'run.rowdy.aws': 'microvm' } }) });

      await lastValueFrom(compute.attach('sandbox-box'));

      expect(compute.sandboxId).toBe('sandbox-box');
    });

    it("finds a sandbox by its name, at the ARN of the caller's own account and region", async () => {
      const { compute, sent } = setup({ ListTagsCommand: () => ({ Tags: { 'run.rowdy.aws': 'microvm' } }) });

      await lastValueFrom(compute.attach('sandbox-box'));

      expect(input(sent, 'ListTagsCommand')).toEqual({ Resource: IMAGE_ARN });
      expect(compute['imageArn']).toBe(IMAGE_ARN);
    });

    it('refuses an image that is not one', async () => {
      const { compute } = setup({ ListTagsCommand: () => ({ Tags: {} }) });

      await expect(lastValueFrom(compute.attach('sandbox-box'))).rejects.toThrow('Not a sandbox: sandbox-box');
    });

    it('connects to a sandbox whose meta has every entry asked for', async () => {
      const Tags = { 'run.rowdy.aws': 'microvm', 'run.rowdy.meta.sub': 'github:1', 'run.rowdy.meta.x': 'y' };
      const { compute } = setup({ ListTagsCommand: () => ({ Tags }) });

      await expect(lastValueFrom(compute.attach('sandbox-box', { sub: 'github:1' }))).resolves.toBe(compute);
    });

    it("refuses a sandbox whose meta doesn't match", async () => {
      const Tags = { 'run.rowdy.aws': 'microvm', 'run.rowdy.meta.sub': 'github:1' };
      const { compute } = setup({ ListTagsCommand: () => ({ Tags }) });

      await expect(lastValueFrom(compute.attach('sandbox-box', { sub: 'github:2' }))).rejects.toThrow(
        'Not a sandbox: sandbox-box'
      );
    });
  });

  it('has no sandbox before create', () => {
    expect(() => setup().compute.sandboxId).toThrow('Sandbox has no image');
  });

  describe('exec', () => {
    const STARTED = new Date('2026-11-06T12:00:00Z');
    const EVENT = { apiVersion: 'rowdy.run/v1alpha1', kind: 'Exec', spec: { cmd: 'echo', args: ['hi'] } } as never;
    const CMD = 'cmd-1';

    const frame = (stream: number, payload: string): Buffer => execFrame(stream, Buffer.from(payload));
    const exit = (code = 0): Buffer => frame(EXEC_STREAM.EXIT, JSON.stringify({ code }));

    const body = (chunks: Uint8Array[]): Response =>
      new Response(
        new ReadableStream({
          start: (controller) => {
            chunks.forEach((chunk) => controller.enqueue(chunk));
            controller.close();
          },
        }),
        { status: 200, headers: { [EXEC_ID_HEADER]: CMD } }
      );

    const running = (
      handlers: Record<string, Handler> = {},
      chunks: Uint8Array[] = [exit()]
    ): ReturnType<typeof setup> & { fetch: jest.SpyInstance } => {
      const fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => body(chunks));
      const built = setup({
        GetMicrovmImageCommand: () => ({ latestActiveImageVersion: '1.0', tags: { 'run.rowdy.timeout': '600' } }),
        ListMicrovmsCommand: () => ({ items: [] }),
        GetMicrovmImageVersionCommand: () => ({
          buildRoleArn: ROLE_ARN,
          logging: { cloudWatch: { logGroup: '/aws/lambda-microvms/sandbox' } },
        }),
        RunMicrovmCommand: () => ({ microvmId: 'mvm-1' }),
        GetMicrovmCommand: () => ({
          microvmId: 'mvm-1',
          state: 'RUNNING',
          endpoint: 'vm.example',
          imageVersion: '1.0',
          startedAt: STARTED,
        }),
        CreateMicrovmAuthTokenCommand: () => ({ authToken: { 'X-aws-proxy-auth': 'token' } }),
        ...handlers,
      });
      built.compute['image'].withArn(IMAGE_ARN);
      return { ...built, fetch };
    };

    const run = async (compute: MicrovmCompute): Promise<ExecFinished> =>
      new Promise((resolve, reject) => {
        const subscription = compute.exec(EVENT).subscribe({
          next: (exec) =>
            exec
              .wait()
              .then(resolve, reject)
              .finally(() => subscription.unsubscribe()),
          error: reject,
        });
      });

    it('brings back stdout, stderr and the exit code', async () => {
      const { compute } = running({}, [
        frame(EXEC_STREAM.STDOUT, 'hello world\n'),
        frame(EXEC_STREAM.STDERR, 'oops\n'),
        exit(3),
      ]);

      const done = await run(compute);

      expect(done.exitCode).toBe(3);
      expect(CmdId.parse(done.cmdId, 'sandbox-box')).toEqual({
        sandbox: 'sandbox-box',
        day: STARTED.toISOString().slice(0, 10).replace(/-/g, '/'),
        version: '1.0',
        vm: 'mvm-1',
        exec: CMD,
      });
      await expect(done.stdout()).resolves.toBe('hello world\n');
      await expect(done.stderr()).resolves.toBe('oops\n');
    });

    it('reassembles a frame split across chunks', async () => {
      const whole = Buffer.concat([frame(EXEC_STREAM.STDOUT, 'hello'), exit()]);
      const { compute } = running({}, [whole.subarray(0, 3), whole.subarray(3, 10), whole.subarray(10)]);

      await expect((await run(compute)).stdout()).resolves.toBe('hello');
    });

    it('rejects when the connection drops before the exit', async () => {
      const { compute } = running({}, [frame(EXEC_STREAM.STDOUT, 'partial')]);

      await expect(run(compute)).rejects.toThrow('Command ended without an exit');
    });

    it('starts a VM from the image, for its timeout', async () => {
      const { compute, sent } = running();

      await run(compute);

      expect(input(sent, 'RunMicrovmCommand')).toMatchObject({
        imageIdentifier: IMAGE_ARN,
        imageVersion: '1.0',
        executionRoleArn: ROLE_ARN,
        maximumDurationInSeconds: 600,
        idlePolicy: { maxIdleDurationSeconds: 600 },
        ingressNetworkConnectors: [expect.stringContaining('HTTP_INGRESS')],
        egressNetworkConnectors: [expect.stringContaining('INTERNET_EGRESS')],
      });
    });

    it('uses a live VM rather than starting another', async () => {
      const { compute, sent } = running({
        ListMicrovmsCommand: () => ({ items: [{ microvmId: 'mvm-1', state: 'RUNNING' }] }),
      });

      await run(compute);

      expect(names(sent)).not.toContain('RunMicrovmCommand');
    });

    it('starts a VM when the only one is ending', async () => {
      const { compute, sent } = running({
        ListMicrovmsCommand: () => ({ items: [{ microvmId: 'old', state: 'TERMINATED' }] }),
      });

      await run(compute);

      expect(names(sent)).toContain('RunMicrovmCommand');
    });

    describe('files', () => {
      const { signal } = new AbortController();
      const answering = (status: number, body?: string | Uint8Array) => {
        const built = running();
        built.fetch.mockImplementation(async () => new Response(body ?? null, { status }));
        return built;
      };
      const called = (fetch: jest.SpyInstance) => {
        const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
        return { url: new globalThis.URL(url), init };
      };

      it('writes a file with PUT, its path and mode in the query', async () => {
        const { compute, fetch } = answering(204);
        const content = Buffer.from([0, 255]);

        await lastValueFrom(compute.writeFile('app/run.sh', content, 0o755, signal), { defaultValue: undefined });

        const { url, init } = called(fetch);
        expect(url.host).toBe('vm.example');
        expect(url.pathname).toBe(FILES_PATH);
        expect(Object.fromEntries(url.searchParams)).toEqual({ path: 'app/run.sh', mode: '755' });
        expect(init).toMatchObject({ method: 'PUT', body: content, signal });
        expect(init.headers).toMatchObject({ 'X-aws-proxy-auth': 'token', 'X-aws-proxy-port': `${HOOKS_PORT}` });
      });

      it('reads a file, or null when it is not there', async () => {
        const found = answering(200, new Uint8Array([1, 2, 3]));
        await expect(lastValueFrom(found.compute.readFile('a', {}, signal))).resolves.toEqual(Buffer.from([1, 2, 3]));
        expect(called(found.fetch).init.headers).not.toHaveProperty('range');

        jest.restoreAllMocks();
        const missing = answering(404);
        await expect(lastValueFrom(missing.compute.readFile('a', {}, signal))).resolves.toBeNull();
      });

      it.each([
        [{ offset: 2, length: 3 }, 'bytes=2-4'],
        [{ offset: 7 }, 'bytes=7-'],
        [{ length: 4 }, 'bytes=0-3'],
      ])('asks for only %j, as %s', async (range, header) => {
        const { compute, fetch } = answering(206, new Uint8Array([2, 3, 4]));

        await expect(lastValueFrom(compute.readFile('a', range, signal))).resolves.toEqual(Buffer.from([2, 3, 4]));
        expect(called(fetch).init.headers).toMatchObject({ range: header, 'X-aws-proxy-auth': 'token' });
      });

      it('cuts the range itself from a runtime that sent the whole file', async () => {
        const { compute } = answering(200, new Uint8Array([0, 1, 2, 3, 4, 5]));

        await expect(lastValueFrom(compute.readFile('a', { offset: 2, length: 3 }, signal))).resolves.toEqual(
          Buffer.from([2, 3, 4])
        );
      });

      it('reads no bytes from past the end', async () => {
        const { compute } = answering(416);

        await expect(lastValueFrom(compute.readFile('a', { offset: 10 }, signal))).resolves.toEqual(Buffer.alloc(0));
      });

      it('makes a directory with POST', async () => {
        const { compute, fetch } = answering(204);

        await lastValueFrom(compute.mkDir('/data/cache', signal), { defaultValue: undefined });

        const { url, init } = called(fetch);
        expect(Object.fromEntries(url.searchParams)).toEqual({ path: '/data/cache' });
        expect(init.method).toBe('POST');
      });

      it.each([
        ['writing', (compute: MicrovmCompute) => compute.writeFile('f', Buffer.from('x'), undefined, signal)],
        ['reading', (compute: MicrovmCompute) => compute.readFile('f', {}, signal)],
        ['making', (compute: MicrovmCompute) => compute.mkDir('f', signal)],
      ])('says why %s failed', async (_, call) => {
        const { compute } = answering(500, 'EACCES: permission denied');

        await expect(lastValueFrom(call(compute) as Observable<unknown>)).rejects.toThrow('EACCES: permission denied');
      });

      it('starts the VM like a command would', async () => {
        const { compute, sent } = answering(204);

        await lastValueFrom(compute.mkDir('d', signal), { defaultValue: undefined });

        expect(sent.map(({ name }) => name)).toContain('RunMicrovmCommand');
      });
    });

    it('starts one VM for two first commands at once, across handles', async () => {
      const first = running();
      const second = running();

      await Promise.all([run(first.compute), run(second.compute)]);

      const started = [...first.sent, ...second.sent].filter(({ name }) => name === 'RunMicrovmCommand');
      expect(started).toHaveLength(1);
    });

    it('looks again for a VM once a start has settled', async () => {
      const { compute, sent } = running();

      await run(compute);
      await run(compute);

      expect(sent.filter(({ name }) => name === 'ListMicrovmsCommand')).toHaveLength(2);
    });

    it('lets a failed start be tried again', async () => {
      const failing = running({ RunMicrovmCommand: () => Promise.reject(new Error('capacity')) });
      await expect(run(failing.compute)).rejects.toThrow('capacity');

      const { compute, sent } = running();
      await run(compute);

      expect(sent.filter(({ name }) => name === 'RunMicrovmCommand')).toHaveLength(1);
    });

    it('waits for a new VM to run', async () => {
      const states = ['PENDING', 'RUNNING'];
      const { compute, sent } = running({
        GetMicrovmCommand: () => ({
          microvmId: 'mvm-1',
          state: states.shift(),
          endpoint: 'vm.example',
          imageVersion: '1.0',
          startedAt: STARTED,
        }),
      });

      await run(compute);

      expect(names(sent).filter((name) => name === 'GetMicrovmCommand')).toHaveLength(2);
    });

    it('rejects when the VM never runs', async () => {
      const { compute } = running({
        GetMicrovmCommand: () => ({ state: 'TERMINATED', stateReason: 'capacity' }),
      });

      await expect(run(compute)).rejects.toThrow('stopped: capacity');
    });

    it('posts the event to rowdy, with a token for its port only', async () => {
      const { compute, sent, fetch } = running();

      await run(compute);

      expect(input(sent, 'CreateMicrovmAuthTokenCommand')).toMatchObject({ allowedPorts: [{ port: HOOKS_PORT }] });
      expect(fetch).toHaveBeenCalledWith(`https://vm.example${EXEC_PATH}`, {
        method: 'POST',
        headers: { 'X-aws-proxy-auth': 'token', 'X-aws-proxy-port': `${HOOKS_PORT}` },
        body: JSON.stringify(EVENT),
        signal: expect.any(AbortSignal),
      });
    });

    it('rejects when rowdy refuses the command', async () => {
      const { compute, fetch } = running();
      fetch.mockResolvedValue(new Response('', { status: 400 }));

      await expect(run(compute)).rejects.toThrow('Command refused: 400');
    });

    it('hangs up when unsubscribed, leaving the command running', async () => {
      const { compute, fetch } = running({}, [frame(EXEC_STREAM.STDOUT, 'a'), exit()]);

      await run(compute);

      expect((fetch.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
    });

    it('needs a sandbox', async () => {
      await expect(lastValueFrom(setup().compute.exec(EVENT))).rejects.toThrow('Sandbox has no image');
    });

    describe('status', () => {
      const status = (compute: MicrovmCompute) => lastValueFrom(compute.status());

      it.each([
        [{ state: 'CREATING' }, { state: 'building' }],
        [{ state: 'UPDATING', latestActiveImageVersion: '1.0' }, { state: 'building' }],
        [{ state: 'CREATED', latestActiveImageVersion: '1.0' }, { state: 'ready' }],
        [{ state: 'UPDATED', latestActiveImageVersion: '2.0' }, { state: 'ready' }],
      ])('makes an image %j into %j', async (image, expected) => {
        const { compute } = running({ GetMicrovmImageCommand: () => image });

        expect(await status(compute)).toEqual(expected);
      });

      it('says why a build failed', async () => {
        const { compute, sent } = running({
          GetMicrovmImageCommand: () => ({ state: 'CREATE_FAILED', latestFailedImageVersion: '1.0' }),
          GetMicrovmImageVersionCommand: () => ({ state: 'FAILED', stateReason: 'ready hook timed out' }),
        });

        expect(await status(compute)).toEqual({ state: 'failed', reason: 'ready hook timed out' });
        expect(input(sent, 'GetMicrovmImageVersionCommand')).toEqual({
          imageIdentifier: IMAGE_ARN,
          imageVersion: '1.0',
        });
      });
    });

    describe('before its build is done', () => {
      it.each([
        ['CREATING', 'still building'],
        ['CREATE_FAILED', 'failed to build'],
      ])('refuses a command on an image that is %s', async (state, message) => {
        const { compute, sent } = running({ GetMicrovmImageCommand: () => ({ state }) });

        await expect(lastValueFrom(compute.exec(EVENT))).rejects.toThrow(message);
        expect(names(sent)).not.toContain('RunMicrovmCommand');
      });
    });

    describe('delete', () => {
      const ZIP = `s3://rowdy-sandboxes-abc/sandbox-box/${IMAGE_URI}.zip`;
      const ROWDY_ROLE = 'arn:aws:iam::123456789012:role/scaffoldly+sandbox@sandbox-box.rowdy.run';
      const deleting = (handlers: Record<string, Handler> = {}): ReturnType<typeof running> =>
        running({
          ListMicrovmsCommand: () => ({ items: [{ microvmId: 'a', state: 'RUNNING' }] }),
          TerminateMicrovmCommand: () => ({}),
          GetMicrovmCommand: () => ({ state: 'TERMINATED' }),
          GetMicrovmImageVersionCommand: () => ({
            buildRoleArn: ROWDY_ROLE,
            codeArtifact: { uri: ZIP },
            logging: { cloudWatch: { logGroup: '/aws/lambda-microvms/sandbox-box' } },
          }),
          DeleteRolePolicyCommand: () => ({}),
          DeleteRoleCommand: () => ({}),
          DeleteObjectCommand: () => ({}),
          DeleteLogGroupCommand: () => ({}),
          DeleteMicrovmImageCommand: () => ({}),
          ...handlers,
        });
      const remove = (compute: MicrovmCompute): Promise<MicrovmCompute> => lastValueFrom(compute.delete());
      const deletes = (sent: Sent[]): string[] =>
        names(sent).filter((name) => name.startsWith('Delete') || name === 'TerminateMicrovmCommand');

      it('stops it, then removes its role, zip and log group, and its image last', async () => {
        const { compute, sent } = deleting();

        await expect(remove(compute)).resolves.toBe(compute);

        expect(deletes(sent)).toEqual([
          'TerminateMicrovmCommand',
          'DeleteRolePolicyCommand',
          'DeleteRoleCommand',
          'DeleteObjectCommand',
          'DeleteLogGroupCommand',
          'DeleteMicrovmImageCommand',
        ]);
        expect(input(sent, 'DeleteRolePolicyCommand')).toEqual({
          RoleName: 'scaffoldly+sandbox@sandbox-box.rowdy.run',
          PolicyName: 'RowdyPolicy',
        });
        expect(input(sent, 'DeleteObjectCommand')).toEqual({
          Bucket: 'rowdy-sandboxes-abc',
          Key: `sandbox-box/${IMAGE_URI}.zip`,
        });
        expect(input(sent, 'DeleteLogGroupCommand')).toEqual({ logGroupName: '/aws/lambda-microvms/sandbox-box' });
        expect(input(sent, 'DeleteMicrovmImageCommand')).toEqual({ imageIdentifier: IMAGE_ARN });
      });

      it('waits for its VMs to finish terminating before the image goes', async () => {
        const refusals = [
          Object.assign(new Error('Cannot delete microvm image with running microvms.'), {
            name: 'ValidationException',
          }),
        ];
        const { compute, sent } = deleting({
          DeleteMicrovmImageCommand: () => (refusals.length ? Promise.reject(refusals.shift()) : {}),
        });

        await expect(remove(compute)).resolves.toBe(compute);
        expect(names(sent).filter((name) => name === 'DeleteMicrovmImageCommand')).toHaveLength(2);
      });

      it('asks AWS for nothing a create does', async () => {
        const { compute, sent } = deleting();

        await remove(compute);

        [
          'CreateLogGroupCommand',
          'GetCallerIdentityCommand',
          'CreateRoleCommand',
          'ListManagedMicrovmImagesCommand',
        ].forEach((name) => expect(names(sent)).not.toContain(name));
      });

      it("leaves a role, bucket or log group rowdy didn't make", async () => {
        const { compute, sent } = deleting({
          GetMicrovmImageVersionCommand: () => ({
            buildRoleArn: 'arn:aws:iam::123456789012:role/admin',
            codeArtifact: { uri: 's3://someone-elses/key.zip' },
            logging: { cloudWatch: { logGroup: '/aws/lambda/app' } },
          }),
        });

        await remove(compute);

        expect(deletes(sent)).toEqual(['TerminateMicrovmCommand', 'DeleteMicrovmImageCommand']);
      });

      it('goes on past parts that are gone already', async () => {
        const { compute, sent } = deleting({
          DeleteRolePolicyCommand: () => Promise.reject(missing('NoSuchEntityException')),
          DeleteRoleCommand: () => Promise.reject(missing('NoSuchEntityException')),
          DeleteLogGroupCommand: () => Promise.reject(missing('ResourceNotFoundException')),
        });

        await remove(compute);

        expect(deletes(sent)).toContain('DeleteMicrovmImageCommand');
      });

      it('does nothing more for an image that is gone', async () => {
        const { compute, sent } = deleting({
          ListMicrovmsCommand: () => ({ items: [] }),
          GetMicrovmImageCommand: () => Promise.reject(missing('ResourceNotFoundException')),
        });

        await expect(remove(compute)).resolves.toBe(compute);
        expect(deletes(sent)).toEqual([]);
      });

      it.each(['DELETING', 'DELETED'])('does nothing more for an image AWS has %s', async (state) => {
        const { compute, sent } = deleting({
          ListMicrovmsCommand: () => ({ items: [] }),
          GetMicrovmImageCommand: () => ({ state, latestActiveImageVersion: '1.0' }),
        });

        await expect(remove(compute)).resolves.toBe(compute);
        expect(deletes(sent)).toEqual([]);
      });

      it('keeps the image when a part fails, so the delete can be repeated', async () => {
        const { compute, sent } = deleting({ DeleteRoleCommand: () => Promise.reject(missing('AccessDenied')) });

        await expect(remove(compute)).rejects.toMatchObject({ name: 'AccessDenied' });
        expect(deletes(sent)).not.toContain('DeleteMicrovmImageCommand');
      });
    });

    describe('stop', () => {
      const stop = (compute: MicrovmCompute): Promise<MicrovmCompute> => lastValueFrom(compute.stop());
      const stopped = (sent: Sent[]): unknown[] =>
        sent.filter(({ name }) => name === 'TerminateMicrovmCommand').map(({ input }) => input.microvmIdentifier);

      it('terminates what is live, and nothing else', async () => {
        const { compute, sent } = running({
          GetMicrovmCommand: () => ({ state: 'TERMINATED' }),
          ListMicrovmsCommand: () => ({
            items: [
              { microvmId: 'a', state: 'RUNNING' },
              { microvmId: 'b', state: 'SUSPENDED' },
              { microvmId: 'c', state: 'TERMINATED' },
              { microvmId: 'd', state: 'TERMINATING' },
            ],
          }),
          TerminateMicrovmCommand: () => ({}),
        });

        await stop(compute);

        expect(stopped(sent)).toEqual(['a', 'b']);
        expect(input(sent, 'ListMicrovmsCommand')).toEqual({ imageIdentifier: IMAGE_ARN });
      });

      it('does nothing with nothing running', async () => {
        const { compute, sent } = running();

        await expect(stop(compute)).resolves.toBe(compute);
        expect(stopped(sent)).toEqual([]);
      });

      it.each(['ResourceNotFoundException', 'ConflictException'])('is fine with a VM that ended: %s', async (name) => {
        const { compute } = running({
          GetMicrovmCommand: () => Promise.reject(missing('ResourceNotFoundException')),
          ListMicrovmsCommand: () => ({ items: [{ microvmId: 'a', state: 'RUNNING' }] }),
          TerminateMicrovmCommand: () => Promise.reject(missing(name)),
        });

        await expect(stop(compute)).resolves.toBe(compute);
      });

      it('rejects on any other failure', async () => {
        const { compute } = running({
          ListMicrovmsCommand: () => ({ items: [{ microvmId: 'a', state: 'RUNNING' }] }),
          TerminateMicrovmCommand: () => Promise.reject(missing('AccessDeniedException')),
        });

        await expect(stop(compute)).rejects.toThrow('missing');
      });

      it('waits for the VM to be gone', async () => {
        const states = ['RUNNING', 'TERMINATING'];
        const { compute, sent } = running({
          GetMicrovmCommand: () => ({ state: states.shift() }),
          ListMicrovmsCommand: () => ({ items: [{ microvmId: 'a', state: 'RUNNING' }] }),
          TerminateMicrovmCommand: () => ({}),
        });

        await stop(compute);

        expect(names(sent).filter((name) => name === 'GetMicrovmCommand')).toHaveLength(2);
      });

      it('fails a command in progress at once', async () => {
        const { compute, fetch } = running({ ListMicrovmsCommand: () => ({ items: [] }) });
        fetch.mockImplementation(
          async (_, init) =>
            new Response(
              new ReadableStream({
                start: (controller) =>
                  (init as RequestInit).signal?.addEventListener('abort', () =>
                    controller.error((init as RequestInit).signal?.reason)
                  ),
              }),
              { status: 200 }
            )
        );

        const command = run(compute);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await stop(compute);

        await expect(command).rejects.toThrow('Sandbox stopped');
      });

      it('needs a sandbox', async () => {
        await expect(stop(setup().compute)).rejects.toThrow('Sandbox has no image');
      });
    });

    it('records the timeout on the image', async () => {
      const { compute, sent } = setup();

      await create(compute);

      expect(input(sent, 'CreateMicrovmImageCommand').tags).toMatchObject({ 'run.rowdy.timeout': '60' });
    });

    it('keeps meta on the image as tags', async () => {
      const { compute, sent } = setup();

      await lastValueFrom(compute.create({ ...SPEC, meta: { sub: 'github:1' } }));

      expect(input(sent, 'CreateMicrovmImageCommand').tags).toMatchObject({ 'run.rowdy.meta.sub': 'github:1' });
    });
  });
});
