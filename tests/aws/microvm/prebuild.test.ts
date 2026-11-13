import { createHash } from 'crypto';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { lastValueFrom, of } from 'rxjs';
import { Logger } from '../../../src';
import { SandboxEnvironment } from '../../../src/sandbox/internal/environment';
import { MicrovmImage, POLL } from '../../../src/aws/microvm/index';
import { COMPUTE_TAG } from '../../../src/aws/microvm/index';
import { META_TAG, TAG_VALUE_REGEX } from '../../../src/aws/tags';
import type { TPulledImage } from '../../../src/api/types';

type Sent = { name: string; input: Record<string, unknown> };
type Handler = (input: Record<string, unknown>) => unknown;
type Client = {
  send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown>;
};

const IMAGE_URI = '123456789012.dkr.ecr.us-east-1.amazonaws.com/tunneld-it/ubuntu@sha256:ecr';
const DIGEST = `sha256:${'0d5255be560e2d2ddcfbfda88549e9e815ef29e7'}${'c'.repeat(24)}`;
const ROWDY = { from: 'ghcr.io/scaffoldly/rowdy:beta', digest: `sha256:${'a'.repeat(64)}` };
const TUNNELD = { from: 'ghcr.io/tunneld-it/tunneld:latest', digest: `sha256:${'b'.repeat(64)}` };
const BASE_ARN = 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1';
const VERSION = (architecture: string) => ({
  imageVersion: '7',
  createdAt: new Date(1),
  status: 'AVAILABLE',
  supportedCpuConfigurations: [{ architecture }],
});

const PULLED: TPulledImage = {
  Image: 'ghcr.io/tunneld-it/ubuntu:latest',
  ImageUri: IMAGE_URI,
  Source: {
    registry: 'ghcr.io',
    namespace: 'tunneld-it',
    name: 'ubuntu',
    tag: 'latest',
    digest: DIGEST,
    base: { name: 'mirror.gcr.io/library/ubuntu:latest', digest: `sha256:${'d'.repeat(64)}` },
  },
  Layers: [ROWDY, TUNNELD],
};

const missing = (name: string): Error => Object.assign(new Error('missing'), { name });

describe('aws microvm prebuild', () => {
  const timing = { ...POLL };
  beforeAll(() => Object.assign(POLL, { delay: 1 }));
  afterAll(() => Object.assign(POLL, timing));
  afterEach(() => jest.restoreAllMocks());

  const setup = (
    handlers: Record<string, Handler> = {},
    pulled: TPulledImage = PULLED,
    platform: 'linux/amd64' | 'linux/arm64' = 'linux/amd64'
  ): { image: MicrovmImage; sent: Sent[]; environment: SandboxEnvironment } => {
    const environment = new SandboxEnvironment(new Logger());
    const image = new MicrovmImage(environment)
      .withImage('ghcr.io/tunneld-it/ubuntu:latest', ['ghcr.io/tunneld-it/tunneld:latest'])
      .withPlatform(platform)
      .withMemory(512)
      .withPrebuild();
    const sent: Sent[] = [];
    const architecture = platform === 'linux/arm64' ? 'ARM_64' : 'X86_64';
    const defaults: Record<string, Handler> = {
      ListManagedMicrovmImagesCommand: () => ({ items: [{ imageArn: BASE_ARN, createdAt: new Date(1) }] }),
      ListManagedMicrovmImageVersionsCommand: () => ({ items: [VERSION(architecture)] }),
      ListBucketsCommand: () => ({ Buckets: [] }),
      CreateBucketCommand: () => ({}),
      HeadObjectCommand: () => Promise.reject(missing('NotFound')),
      PutObjectCommand: () => ({}),
      GetCallerIdentityCommand: () => ({ Account: '123456789012' }),
      CreateLogGroupCommand: () => ({}),
      CreateRoleCommand: () => Promise.reject(missing('EntityAlreadyExistsException')),
      UpdateAssumeRolePolicyCommand: () => ({}),
      GetRoleCommand: () => ({ Role: { Arn: 'arn:aws:iam::123456789012:role/box' } }),
      PutRolePolicyCommand: () => ({}),
      GetMicrovmImageCommand: () => Promise.reject(missing('ResourceNotFoundException')),
      CreateMicrovmImageCommand: () => ({ imageVersion: '1.0' }),
      GetMicrovmImageVersionCommand: () => ({ state: 'SUCCESSFUL' }),
    };
    const send: Client['send'] = async (command) => {
      const { name } = command.constructor;
      sent.push({ name, input: command.input });
      const handler = handlers[name] ?? defaults[name];
      if (!handler) throw new Error(`unexpected ${name}`);
      return handler(command.input);
    };
    const clients = image as unknown as Record<'iam' | 'logs' | 'microvms' | 's3' | 'sts', Client>;
    [clients.iam, clients.logs, clients.microvms, clients.s3, clients.sts].forEach((client) => (client.send = send));
    jest.spyOn(image['s3'].config, 'region').mockResolvedValue('us-east-1');
    jest.spyOn(environment.images, 'pullImage').mockReturnValue(of(pulled));
    return { image, sent, environment };
  };

  const input = (sent: Sent[], name: string): Record<string, unknown> => sent.find((s) => s.name === name)!.input;
  const names = (sent: Sent[]): string[] => sent.map(({ name }) => name);
  const tags = (sent: Sent[]): Record<string, string> =>
    input(sent, 'CreateMicrovmImageCommand').tags as Record<string, string>;
  const build = async (image: MicrovmImage): Promise<MicrovmImage> => {
    await lastValueFrom(image.observe());
    return image;
  };

  it('is named for its platform digest and its build-spec hash', async () => {
    const { image, sent } = setup();

    await build(image);

    const { name } = input(sent, 'CreateMicrovmImageCommand') as { name: string };
    expect(name).toMatch(/^0d5255be560e2d2ddcfbfda88549e9e815ef29e7-[0-9a-f]{23}$/);
    expect(name).toHaveLength(64);
    expect(name.split('-')[1]).toBe(tags(sent).spec!.slice(0, 23));
    expect(image.State.ImageArn).toBe(`arn:aws:lambda:us-east-1:123456789012:microvm-image:${name}`);
    expect(input(sent, 'CreateLogGroupCommand')).toEqual({ logGroupName: `/aws/lambda-microvms/${name}` });
  });

  it('copies its image for the platform, with rowdy first', async () => {
    const { image, environment } = setup({}, PULLED, 'linux/arm64');

    await build(image);

    expect(environment.images.pullImage).toHaveBeenCalledWith('ghcr.io/tunneld-it/ubuntu:latest', {
      layersFrom: ['ghcr.io/scaffoldly/rowdy:beta', 'ghcr.io/tunneld-it/tunneld:latest'],
      platform: 'linux/arm64',
    });
  });

  it('builds ARM_64 for linux/arm64, on a base for it', async () => {
    const { image, sent } = setup({}, PULLED, 'linux/arm64');

    await build(image);

    expect(input(sent, 'CreateMicrovmImageCommand')).toMatchObject({
      cpuConfigurations: [{ architecture: 'ARM_64' }],
      baseImageArn: BASE_ARN,
      baseImageVersion: '7',
    });
    expect(tags(sent)).toMatchObject({ platform: 'linux/arm64', architecture: 'ARM_64' });
  });

  it('tags what it was built from, every layer with its digest', async () => {
    const { image, sent } = setup();

    await build(image);

    expect(tags(sent)).toMatchObject({
      registry: 'ghcr.io',
      namespace: 'tunneld-it',
      name: 'ubuntu',
      tag: 'latest',
      sha256: DIGEST.replace('sha256:', ''),
      platform: 'linux/amd64',
      'layer.0': `${ROWDY.from}@${ROWDY.digest}`,
      'layer.1': `${TUNNELD.from}@${TUNNELD.digest}`,
      baseImageArn: BASE_ARN,
      baseImageVersion: '7',
      minimumMemoryInMiB: '512',
      memory: '512',
      rowdy: expect.any(String),
    });
  });

  it('tags when it was built and the FROM its build annotated, outside the hash', async () => {
    const { image, sent } = setup();
    const { image: other, sent: otherSent } = setup({}, { ...PULLED, Source: { ...PULLED.Source!, base: undefined } });

    await build(image);
    await build(other);

    expect(tags(sent)).toMatchObject({
      built: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      from: 'mirror.gcr.io/library/ubuntu:latest',
      'from.sha256': 'd'.repeat(64),
    });
    expect(tags(otherSent)).not.toHaveProperty('from');
    expect(tags(otherSent).spec).toBe(tags(sent).spec);
  });

  it('has every tag as AWS takes it', async () => {
    const { image, sent } = setup();

    await build(image);

    Object.entries(tags(sent)).forEach(([key, value]) => {
      expect(key.length).toBeLessThanOrEqual(128);
      expect(value).toMatch(TAG_VALUE_REGEX);
    });
  });

  it("carries none of a sandbox's tags", async () => {
    const { image, sent } = setup();

    await build(image.withMeta({ owner: 'someone' }).withTimeout(60_000));

    expect(tags(sent)).not.toHaveProperty(COMPUTE_TAG);
    expect(tags(sent)).not.toHaveProperty('run.rowdy.timeout');
    expect(Object.keys(tags(sent)).filter((key) => key.startsWith(META_TAG))).toEqual([]);
  });

  it('hashes its environment, never tags its values', async () => {
    const { image, sent } = setup();

    await build(image.withEnvironment({ TOKEN: 'secret-value' }));

    expect(Object.values(tags(sent)).join(' ')).not.toContain('secret-value');
  });

  it('names the same spec the same, whatever its layers and rowdy are now', async () => {
    const first = setup();
    const moved = setup(
      {},
      {
        ...PULLED,
        ImageUri: IMAGE_URI.replace('sha256:ecr', 'sha256:recopied'),
        Layers: [
          { ...ROWDY, digest: `sha256:${'f'.repeat(64)}` },
          { ...TUNNELD, digest: `sha256:${'e'.repeat(64)}` },
        ],
      }
    );
    Object.assign(moved.environment, { version: '9.9.9' });

    await Promise.all([build(first.image), build(moved.image)]);

    const named = (sent: Sent[]) => input(sent, 'CreateMicrovmImageCommand').name;
    expect(named(moved.sent)).toBe(named(first.sent));
    expect(tags(moved.sent)).toMatchObject({ rowdy: '9.9.9', 'layer.1': `${TUNNELD.from}@sha256:${'e'.repeat(64)}` });
  });

  it('names an image of other layers anew', async () => {
    const first = setup();
    const other = setup(
      {},
      { ...PULLED, Layers: [ROWDY, { from: 'ghcr.io/acme/tools:latest', digest: TUNNELD.digest }] }
    );

    await Promise.all([build(first.image), build(other.image)]);

    const named = (sent: Sent[]) => input(sent, 'CreateMicrovmImageCommand').name;
    expect(named(other.sent)).not.toBe(named(first.sent));
  });

  it('keeps its whole spec beside its zip', async () => {
    const { image, sent } = setup();

    await build(image);

    const { name } = input(sent, 'CreateMicrovmImageCommand') as { name: string };
    const spec = sent.find((s) => s.name === 'PutObjectCommand' && s.input.Key === `${name}/spec.json`)!.input;
    expect(JSON.parse(spec.Body as string)).toMatchObject({
      layers: [ROWDY.from, TUNNELD.from],
      entrypoint: '/usr/local/bin/rowdy',
      spec: tags(sent).spec,
      tags: { 'layer.0': `${ROWDY.from}@${ROWDY.digest}`, rowdy: expect.any(String) },
    });
  });

  it('builds FROM its image in ECR', async () => {
    const { image, sent } = setup();

    await build(image);

    const zip = sent.find((s) => s.name === 'PutObjectCommand' && `${s.input.Key}`.endsWith('.zip'))!.input;
    expect(strFromU8(unzipSync(zip.Body as Uint8Array).Dockerfile!)).toMatch(new RegExp(`^FROM ${IMAGE_URI}\n`));
    expect(image.State.Built).toBe(true);
  });

  it('reuses one built already, building nothing', async () => {
    const probe = setup();
    await build(probe.image);
    const zip = probe.sent.find((s) => s.name === 'PutObjectCommand' && `${s.input.Key}`.endsWith('.zip'))!.input;
    const Dockerfile = strFromU8(unzipSync(zip.Body as Uint8Array).Dockerfile!);
    const ETag = `"${createHash('md5')
      .update(zipSync({ Dockerfile: [Buffer.from(Dockerfile), { mtime: new Date(2000, 0) }] }))
      .digest('hex')}"`;
    const { image, sent } = setup({
      GetMicrovmImageCommand: () => ({ state: 'CREATED', latestActiveImageVersion: '1.0' }),
      HeadObjectCommand: () => ({ ETag }),
    });

    await build(image);

    expect(names(sent)).not.toContain('CreateMicrovmImageCommand');
    expect(names(sent)).not.toContain('UpdateMicrovmImageCommand');
    expect(image.State.Built).toBe(false);
  });

  it('refuses an image with no platform digest to name it by', async () => {
    const { image } = setup({}, { ...PULLED, Source: undefined });

    await expect(build(image)).rejects.toThrow('has no linux/amd64 digest');
  });
});
