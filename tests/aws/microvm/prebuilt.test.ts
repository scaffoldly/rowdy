import { lastValueFrom, of } from 'rxjs';
import { Logger } from '../../../src';
import { SandboxEnvironment } from '../../../src/sandbox/internal/environment';
import { EXEC_FILE_POLL, MicrovmCompute, POLL, PrebuiltRecord, TERMINATE_POLL } from '../../../src/aws/microvm/compute';
import { ComputeSpec, SandboxError } from '../../../src/sandbox/internal/compute';
import type { TPulledImage } from '../../../src/api/types';
import type { Event } from '../../../src/events';
import * as exec from '../../../src/aws/exec';

type Sent = { name: string; input: Record<string, unknown> };
type Handler = (input: Record<string, unknown>) => unknown;
type Client = {
  send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown>;
};

const ACCOUNT = '123456789012';
const IMAGE_URI = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/tunneld-it/ubuntu@sha256:ecr`;
const BASE_ARN = 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1';
const MICROVM_ID = 'microvm-11111111-2222-3333-4444-555555555555';
const STARTED = new Date('2026-11-13T06:00:00.000Z');
const PULLED: TPulledImage = {
  Image: 'ghcr.io/tunneld-it/ubuntu:latest',
  ImageUri: IMAGE_URI,
  Source: {
    registry: 'ghcr.io',
    namespace: 'tunneld-it',
    name: 'ubuntu',
    tag: 'latest',
    digest: `sha256:${'0'.repeat(64)}`,
  },
  Layers: [{ from: 'ghcr.io/scaffoldly/rowdy:beta', digest: `sha256:${'a'.repeat(64)}` }],
};
const SPEC: ComputeSpec = {
  image: 'ghcr.io/tunneld-it/ubuntu:latest',
  name: 'box-abcde',
  timeout: 300_000,
  memory: 1024,
  env: {},
  meta: { sub: 'github:1' },
  layersFrom: [],
  wait: true,
};

const missing = (name: string): Error => Object.assign(new Error('missing'), { name });

describe('aws microvm compute from a prebuilt image', () => {
  const timing = { poll: { ...POLL }, terminate: { ...TERMINATE_POLL } };
  beforeAll(() => Object.assign(POLL, { delay: 1 }) && Object.assign(TERMINATE_POLL, { delay: 1 }));
  afterAll(() => Object.assign(POLL, timing.poll) && Object.assign(TERMINATE_POLL, timing.terminate));
  afterEach(() => jest.restoreAllMocks());

  // The name and hash a prebuilt image of SPEC has, as --build would give them.
  const prebuilt = async (): Promise<{ name: string; hash: string }> => {
    const { compute } = setup();
    return lastValueFrom(
      compute['image'].withImage(SPEC.image, SPEC.layersFrom).withMemory(SPEC.memory).prebuilt(false)
    );
  };

  const setup = (
    handlers: Record<string, Handler> = {}
  ): { compute: MicrovmCompute; sent: Sent[]; events: Event[] } => {
    const environment = new SandboxEnvironment(new Logger());
    const compute = new MicrovmCompute(environment);
    const sent: Sent[] = [];
    const vms: Record<string, string> = {};
    const defaults: Record<string, Handler> = {
      ListManagedMicrovmImagesCommand: () => ({ items: [{ imageArn: BASE_ARN, createdAt: new Date(1) }] }),
      ListManagedMicrovmImageVersionsCommand: () => ({
        items: [
          {
            imageVersion: '3',
            createdAt: new Date(1),
            status: 'AVAILABLE',
            supportedCpuConfigurations: [{ architecture: 'X86_64' }],
          },
        ],
      }),
      GetCallerIdentityCommand: () => ({ Account: ACCOUNT }),
      GetMicrovmImageCommand: () => Promise.reject(missing('ResourceNotFoundException')),
      GetMicrovmImageVersionCommand: () => ({
        state: 'SUCCESSFUL',
        codeArtifact: { uri: 's3://rowdy-sandboxes-abc/prebuilt/zip.zip' },
      }),
      ListBucketsCommand: () => ({ Buckets: [{ Name: 'rowdy-sandboxes-abc' }] }),
      GetBucketTaggingCommand: () => ({ TagSet: [{ Key: 'rowdy:owner', Value: 'rowdy-sandboxes' }] }),
      CreateLogGroupCommand: () => ({}),
      CreateRoleCommand: ({ RoleName }) => ({
        Role: { Arn: `arn:aws:iam::${ACCOUNT}:role/rowdy/sandbox/${RoleName}` },
      }),
      PutRolePolicyCommand: () => ({}),
      RunMicrovmCommand: () => ({ microvmId: MICROVM_ID }),
      GetMicrovmCommand: ({ microvmIdentifier }) => ({
        microvmId: microvmIdentifier,
        state: vms[`${microvmIdentifier}`] ?? 'RUNNING',
        endpoint: 'vm.example',
        imageVersion: '1',
        startedAt: STARTED,
      }),
      TerminateMicrovmCommand: ({ microvmIdentifier }) => {
        vms[`${microvmIdentifier}`] = 'TERMINATED';
        return {};
      },
      PutObjectCommand: () => ({}),
      DeleteRolePolicyCommand: () => ({}),
      DeleteRoleCommand: () => ({}),
      DeleteLogGroupCommand: () => ({}),
      DeleteObjectCommand: () => ({}),
    };
    const send: Client['send'] = async (command) => {
      const { name } = command.constructor;
      sent.push({ name, input: command.input });
      const handler = handlers[name] ?? defaults[name];
      if (!handler) throw new Error(`unexpected ${name}`);
      return handler(command.input);
    };
    const clients = compute as unknown as Record<'s3' | 'sts' | 'microvms', Client> & {
      image: Record<'iam' | 'logs' | 'microvms' | 's3' | 'sts', Client>;
    };
    [
      clients.s3,
      clients.sts,
      clients.microvms,
      clients.image.iam,
      clients.image.logs,
      clients.image.microvms,
      clients.image.s3,
      clients.image.sts,
    ].forEach((client) => (client.send = send));
    jest.spyOn(compute['microvms'].config, 'region').mockResolvedValue('us-east-1');
    jest.spyOn(compute['s3'].config, 'region').mockResolvedValue('us-east-1');
    jest.spyOn(compute['image']['s3'].config, 'region').mockResolvedValue('us-east-1');
    jest.spyOn(environment.images, 'pullImage').mockReturnValue(of(PULLED));
    const events: Event[] = [];
    environment.event$.subscribe((event) => events.push(event));
    return { compute, sent, events };
  };

  const input = (sent: Sent[], name: string): Record<string, unknown> => sent.find((s) => s.name === name)!.input;
  const names = (sent: Sent[]): string[] => sent.map(({ name }) => name);

  // Answers for the prebuilt image of SPEC, built.
  const built = async (tags: Record<string, string> = {}): Promise<Record<string, Handler>> => {
    const { name, hash } = await prebuilt();
    return {
      GetMicrovmImageCommand: ({ imageIdentifier }) =>
        `${imageIdentifier}`.endsWith(`:${name}`)
          ? { state: 'CREATED', latestActiveImageVersion: '1', tags: { spec: hash, ...tags } }
          : Promise.reject(missing('ResourceNotFoundException')),
    };
  };

  describe('create', () => {
    it('looks for one without copying anything', async () => {
      const { compute } = setup(await built());

      await lastValueFrom(compute.create(SPEC));

      expect(compute['environment'].images.pullImage).toHaveBeenCalledWith(
        SPEC.image,
        expect.objectContaining({ upload: false })
      );
      expect(compute['environment'].images.pullImage).toHaveBeenCalledTimes(1);
    });

    it('starts the sandbox as a VM of the prebuilt image, named for it, building nothing', async () => {
      const { compute, sent, events } = setup(await built());

      await lastValueFrom(compute.create(SPEC));

      expect(compute.sandboxId).toBe(MICROVM_ID);
      expect(names(sent)).not.toContain('CreateMicrovmImageCommand');
      expect(names(sent)).not.toContain('UpdateMicrovmImageCommand');
      expect(input(sent, 'RunMicrovmCommand')).toMatchObject({
        imageVersion: '1',
        maximumDurationInSeconds: 300,
      });
      expect(events).toContainEqual(expect.objectContaining({ source: 'sandbox', type: 'prebuilt' }));
    });

    it('runs its VM with no role, so code in it has no credentials, and makes no role or log group', async () => {
      const { compute, sent } = setup(await built());

      await lastValueFrom(compute.create(SPEC));

      const run = input(sent, 'RunMicrovmCommand');
      expect(run).not.toHaveProperty('executionRoleArn');
      expect(run).not.toHaveProperty('logging');
      expect(names(sent)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(CreateRole|PutRolePolicy|CreateLogGroup)Command$/)])
      );
    });

    it('keeps its record by its VM', async () => {
      const { compute, sent } = setup(await built());

      await lastValueFrom(compute.create(SPEC));

      const { Bucket, Key, Body } = input(sent, 'PutObjectCommand') as { Bucket: string; Key: string; Body: string };
      expect(Bucket).toBe('rowdy-sandboxes-abc');
      expect(Key).toBe(`sandboxes/${MICROVM_ID}.json`);
      expect(JSON.parse(Body)).toMatchObject({
        microvmId: MICROVM_ID,
        name: 'box-abcde',
        meta: { sub: 'github:1' },
        timeout: 300_000,
        startedAt: STARTED.toISOString(),
      });
    });

    it('builds its own image when the prebuilt one was built from another spec', async () => {
      const { name } = await prebuilt();
      const { compute, sent } = setup({
        GetMicrovmImageCommand: ({ imageIdentifier }) =>
          `${imageIdentifier}`.endsWith(`:${name}`)
            ? { state: 'CREATED', latestActiveImageVersion: '1', tags: { spec: 'another' } }
            : Promise.reject(missing('ResourceNotFoundException')),
        HeadObjectCommand: () => Promise.reject(missing('NotFound')),
        UpdateAssumeRolePolicyCommand: () => ({}),
        GetRoleCommand: () => ({ Role: { Arn: `arn:aws:iam::${ACCOUNT}:role/box` } }),
        CreateMicrovmImageCommand: () => ({ imageVersion: '1.0' }),
      });

      await lastValueFrom(compute.create(SPEC));

      expect(names(sent)).toContain('CreateMicrovmImageCommand');
      expect(names(sent)).not.toContain('RunMicrovmCommand');
    });

    it('ends a VM it started for a sandbox it could not keep a record of', async () => {
      const { compute, sent } = setup({
        ...(await built()),
        PutObjectCommand: () => Promise.reject(Object.assign(new Error('nope'), { name: 'AccessDenied' })),
      });

      await expect(lastValueFrom(compute.create(SPEC))).rejects.toThrow('nope');

      expect(input(sent, 'TerminateMicrovmCommand')).toEqual({ microvmIdentifier: MICROVM_ID });
    });
  });

  describe('once started', () => {
    const RECORD: PrebuiltRecord = {
      microvmId: MICROVM_ID,
      name: 'box-abcde',
      meta: { sub: 'github:1' },
      timeout: 300_000,
      imageArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:microvm-image:prebuilt`,
      imageVersion: '1',
      bucket: 'rowdy-sandboxes-abc',
      startedAt: STARTED.toISOString(),
    };
    const stored = (record: PrebuiltRecord | null = RECORD): Record<string, Handler> => ({
      GetObjectCommand: ({ Key }) =>
        record && Key === `sandboxes/${record.microvmId}.json`
          ? { Body: { transformToString: async () => JSON.stringify(record) } }
          : Promise.reject(missing('NoSuchKey')),
    });

    it('is found by its VM id', async () => {
      const { compute } = setup(stored());

      await lastValueFrom(compute.attach(MICROVM_ID, { sub: 'github:1' }));

      expect(compute.sandboxId).toBe(MICROVM_ID);
    });

    it("is no one else's", async () => {
      const { compute } = setup(stored());

      await expect(lastValueFrom(compute.attach(MICROVM_ID, { sub: 'github:2' }))).rejects.toBeInstanceOf(SandboxError);
    });

    it('is not found once its record is gone', async () => {
      const { compute } = setup(stored(null));

      await expect(lastValueFrom(compute.attach(MICROVM_ID))).rejects.toMatchObject({
        name: 'ResourceNotFoundException',
      });
    });

    it('stops by ending only its VM', async () => {
      const { compute, sent } = setup(stored());
      await lastValueFrom(compute.attach(MICROVM_ID));

      await lastValueFrom(compute.stop());

      expect(sent.filter(({ name }) => name === 'TerminateMicrovmCommand').map(({ input }) => input)).toEqual([
        { microvmIdentifier: MICROVM_ID },
      ]);
      expect(names(sent)).not.toContain('ListMicrovmsCommand');
    });

    it("can't run a command once its VM has ended", async () => {
      const { compute } = setup({
        ...stored(),
        GetMicrovmCommand: () => ({ microvmId: MICROVM_ID, state: 'TERMINATED' }),
      });
      await lastValueFrom(compute.attach(MICROVM_ID));

      await expect(lastValueFrom(compute['vm']())).rejects.toBeInstanceOf(SandboxError);
    });

    it('deletes its VM and its record, never the prebuilt image', async () => {
      const { compute, sent } = setup(stored());
      await lastValueFrom(compute.attach(MICROVM_ID));

      await lastValueFrom(compute.delete());

      expect(input(sent, 'TerminateMicrovmCommand')).toEqual({ microvmIdentifier: MICROVM_ID });
      expect(input(sent, 'DeleteObjectCommand')).toEqual({
        Bucket: RECORD.bucket,
        Key: `sandboxes/${MICROVM_ID}.json`,
      });
      expect(names(sent)).not.toContain('DeleteMicrovmImageCommand');
      expect(names(sent).indexOf('DeleteObjectCommand')).toBe(names(sent).length - 1);
    });

    describe('its command output, read from the VM', () => {
      const EXEC = '0f0e0d0c-0b0a-4908-8706-050403020100';
      const cmdId = exec.CmdId.stringify({
        sandbox: MICROVM_ID,
        day: '2026/11/13',
        version: '1',
        vm: MICROVM_ID,
        exec: EXEC,
      });
      const json = (seq: number, stream: number, data: string): string =>
        `${JSON.stringify({ 'rowdy.exec': { cmd: EXEC, seq, stream, data: Buffer.from(data).toString('base64') } })}\n`;
      const FILE = json(0, 1, 'one\n') + json(1, 2, 'two\n') + json(2, 4, JSON.stringify({ code: 3 }));

      // The VM's file for EXEC, as it is after `at` reads, read from where it's asked.
      const vmFile = (compute: MicrovmCompute, ...versions: string[]): jest.SpyInstance => {
        let reads = 0;
        return jest
          .spyOn(compute as unknown as { readFile: MicrovmCompute['readFile'] }, 'readFile')
          .mockImplementation((path: string, { offset = 0 }) => {
            const file = versions[Math.min(reads++, versions.length - 1)]!;
            return of(path === `/var/lib/rowdy/exec/${EXEC}.jsonl` ? Buffer.from(file).subarray(offset) : null);
          });
      };

      it('reads every line, and how it ended', async () => {
        const { compute } = setup(stored());
        await lastValueFrom(compute.attach(MICROVM_ID));
        vmFile(compute, FILE);

        const read = await lastValueFrom(compute.output(cmdId));

        expect(read).toMatchObject({ text: 'one\ntwo\n', exitCode: 3, dropped: false });
      });

      it('reads one stream', async () => {
        const { compute } = setup(stored());
        await lastValueFrom(compute.attach(MICROVM_ID));
        vmFile(compute, FILE);

        await expect(lastValueFrom(compute.output(cmdId, { stream: 'stderr' }))).resolves.toMatchObject({
          text: 'two\n',
        });
      });

      it('reads on from its cursor, a line written half-way included once it is whole', async () => {
        const { compute } = setup(stored());
        await lastValueFrom(compute.attach(MICROVM_ID));
        const first = json(0, 1, 'one\n');
        const half = json(1, 1, 'two\n').slice(0, 10);
        const read = vmFile(compute, first + half, FILE.replace(json(1, 2, 'two\n'), json(1, 1, 'two\n')));

        const before = await lastValueFrom(compute.output(cmdId));
        const after = await lastValueFrom(compute.output(cmdId, { cursor: before.cursor }));

        expect(before).toMatchObject({ text: 'one\n', exitCode: undefined, cursor: `${Buffer.byteLength(first)}.1` });
        expect(after).toMatchObject({ text: 'two\n', exitCode: 3 });
        expect(read.mock.calls[1]?.[1]).toEqual({ offset: Buffer.byteLength(first) });
      });

      it('waits for more with a timeout, until it ends', async () => {
        const { compute } = setup(stored());
        await lastValueFrom(compute.attach(MICROVM_ID));
        const timing = { ...EXEC_FILE_POLL };
        Object.assign(EXEC_FILE_POLL, { delay: 1 });
        vmFile(
          compute,
          json(0, 1, 'one\n'),
          json(0, 1, 'one\n'),
          FILE.replace(json(1, 2, 'two\n'), json(1, 1, 'two\n'))
        );

        const read = await lastValueFrom(compute.output(cmdId, { timeout: 5_000 }));
        Object.assign(EXEC_FILE_POLL, timing);

        expect(read).toMatchObject({ text: 'one\ntwo\n', exitCode: 3 });
      });

      it('says its output went with it once its VM has ended', async () => {
        const { compute } = setup({
          ...stored(),
          GetMicrovmCommand: () => ({ microvmId: MICROVM_ID, state: 'TERMINATED' }),
        });
        await lastValueFrom(compute.attach(MICROVM_ID));

        await expect(lastValueFrom(compute.output(cmdId))).rejects.toThrow(
          'This sandbox has stopped, and its command output went with it.'
        );
      });

      it('refuses a command id that names no file of its own', async () => {
        const { compute } = setup(stored());
        await lastValueFrom(compute.attach(MICROVM_ID));
        const sneaky = exec.CmdId.stringify({
          sandbox: MICROVM_ID,
          day: '2026/11/13',
          version: '1',
          vm: MICROVM_ID,
          exec: '..',
        });

        await expect(lastValueFrom(compute.output(sneaky))).rejects.toBeInstanceOf(SandboxError);
      });
    });
  });
});
