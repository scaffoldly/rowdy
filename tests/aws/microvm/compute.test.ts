import { createHash } from 'crypto';
import { strFromU8, unzipSync } from 'fflate';
import { lastValueFrom, Observable } from 'rxjs';
import { Environment, Logger } from '../../../src';
import { ExecFinished } from '../../../src/api/types';
import { MicrovmCompute, POLL, TERMINATE_POLL } from '../../../src/aws/microvm/compute';
import { EXEC_STREAM, execFrame } from '../../../src/proxy/shell';
import { EXEC_ID_HEADER, EXEC_PATH, FILES_PATH, HOOKS_PORT } from '../../../src/aws/microvm';
import { ComputeSpec } from '../../../src/sandbox/internal/compute';

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

  const setup = (handlers: Record<string, Handler> = {}): { compute: MicrovmCompute; sent: Sent[] } => {
    const compute = new MicrovmCompute(new Environment(new Logger(), {}));
    const sent: Sent[] = [];
    const defaults: Record<string, Handler> = {
      ListManagedMicrovmImagesCommand: () => ({ items: [{ imageArn: BASE_ARN, createdAt: new Date(1) }] }),
      ListManagedMicrovmImageVersionsCommand: () => ({ items: [AVAILABLE] }),
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
      expect(Statement[0]).toMatchObject({ Resource: `arn:aws:s3:::${Bucket}/sandbox-box/${IMAGE_URI}.zip` });
      expect(Statement[3]).toMatchObject({
        Action: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
        Resource: 'arn:aws:ecr:us-east-1:123456789012:repository/scaffoldly/sandbox',
      });
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
      built.compute['imageArn'] = IMAGE_ARN;
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
      expect(JSON.parse(Buffer.from(done.cmdId, 'base64url').toString())).toEqual({
        logGroupIdentifiers: ['arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda-microvms/sandbox'],
        logStreamNamePrefixes: [`${STARTED.toISOString().slice(0, 10).replace(/-/g, '/')}[1.0]mvm-1`],
        logEventFilterPattern: `"rowdy.exec" "${CMD}"`,
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
        await expect(lastValueFrom(found.compute.readFile('a', signal))).resolves.toEqual(Buffer.from([1, 2, 3]));

        jest.restoreAllMocks();
        const missing = answering(404);
        await expect(lastValueFrom(missing.compute.readFile('a', signal))).resolves.toBeNull();
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
        ['reading', (compute: MicrovmCompute) => compute.readFile('f', signal)],
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
  });
});
