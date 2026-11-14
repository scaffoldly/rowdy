import { lastValueFrom, map, Observable, OperatorFunction } from 'rxjs';
import { Logger } from '../../src';
import { SandboxEnvironment } from '../../src/sandbox/internal/environment';
import { ImageManifest, Transfer } from '../../src/api/internal/transfer';

describe('pullImage', () => {
  afterEach(() => jest.restoreAllMocks());

  // Transfer's own steps stubbed: what's collected, and an image already copied.
  const pull = (annotations?: Record<string, string>) => {
    const manifest = {
      registry: 'ghcr.io',
      namespace: 'tunneld-it',
      name: 'ubuntu',
      tags: ['latest'],
      index: { manifests: [{ digest: 'sha256:platform', platform: { os: 'linux', architecture: 'amd64' } }] },
      images: [{ manifest: { digest: 'sha256:platform' }, image: { annotations } }],
      sources: [{ from: 'ghcr.io/scaffoldly/rowdy:beta', digest: 'sha256:rowdy' }],
    } as unknown as ImageManifest;
    jest
      .spyOn(Transfer, 'collect')
      .mockReturnValue(map(() => manifest) as unknown as OperatorFunction<unknown, ImageManifest>);
    jest.spyOn(Transfer, 'prepare').mockReturnValue(((source: Observable<unknown>) => source) as never);
    jest.spyOn(Transfer, 'upload').mockReturnValue(((source: Observable<unknown>) => source) as never);
    jest
      .spyOn(Transfer, 'denormalize')
      .mockReturnValue(map(() => ({ imageRef: '123456789012.dkr.ecr.us-east-1.amazonaws.com/x@sha256:ecr' })) as never);
    return lastValueFrom(new SandboxEnvironment(new Logger()).images.pullImage('ghcr.io/tunneld-it/ubuntu:latest'));
  };

  it('says where its image came from, and the digest of the platform it pulled', async () => {
    const pulled = await pull();

    expect(pulled.Source).toEqual({
      registry: 'ghcr.io',
      namespace: 'tunneld-it',
      name: 'ubuntu',
      tag: 'latest',
      digest: 'sha256:platform',
    });
    expect(pulled.Layers).toEqual([{ from: 'ghcr.io/scaffoldly/rowdy:beta', digest: 'sha256:rowdy' }]);
  });

  it('names its image as it would be in ECR without uploading it, when told not to', async () => {
    const manifest = {
      registry: 'ghcr.io',
      slug: 'tunneld-it/ubuntu',
      namespace: 'tunneld-it',
      name: 'ubuntu',
      tags: ['latest'],
      index: { manifests: [{ digest: 'sha256:platform', platform: { os: 'linux', architecture: 'amd64' } }] },
      images: [{ manifest: { digest: 'sha256:platform' }, image: {} }],
      sources: [],
    } as unknown as ImageManifest;
    jest
      .spyOn(Transfer, 'collect')
      .mockReturnValue(map(() => manifest) as unknown as OperatorFunction<unknown, ImageManifest>);
    jest.spyOn(Transfer, 'prepare').mockReturnValue(
      map(() => ({
        registry: { registry: '123456789012.dkr.ecr.us-east-1.amazonaws.com' },
        manifest,
        index: {
          manifests: [
            { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } },
            { digest: 'sha256:rewritten', platform: { os: 'linux', architecture: 'amd64' } },
          ],
        },
      })) as never
    );
    const upload = jest.spyOn(Transfer, 'upload');
    const denormalize = jest.spyOn(Transfer, 'denormalize');

    const pulled = await lastValueFrom(
      new SandboxEnvironment(new Logger()).images.pullImage('ghcr.io/tunneld-it/ubuntu:latest', { upload: false })
    );

    expect(pulled.ImageUri).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/tunneld-it/ubuntu@sha256:rewritten');
    expect(upload).not.toHaveBeenCalled();
    expect(denormalize).not.toHaveBeenCalled();
  });

  it('names a deeper path, as in ECR, by all of it, without uploading', async () => {
    const manifest = Transfer.normalizeImage('ghcr.io/tunneld-it/prebuild/sandbox:latest', null);
    jest
      .spyOn(Transfer, 'collect')
      .mockReturnValue(
        map(() => ({ ...manifest, index: { manifests: [] }, images: [], sources: [] })) as unknown as OperatorFunction<
          unknown,
          ImageManifest
        >
      );
    jest.spyOn(Transfer, 'prepare').mockReturnValue(
      map(() => ({
        registry: { registry: '123456789012.dkr.ecr.us-east-1.amazonaws.com' },
        manifest,
        index: { manifests: [{ digest: 'sha256:rewritten', platform: { os: 'linux', architecture: 'amd64' } }] },
      })) as never
    );

    const pulled = await lastValueFrom(
      new SandboxEnvironment(new Logger()).images.pullImage('ghcr.io/tunneld-it/prebuild/sandbox:latest', {
        upload: false,
      })
    );

    expect(pulled.ImageUri).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/tunneld-it/prebuild/sandbox@sha256:rewritten'
    );
  });

  it('says what its image was built FROM, as its build annotated it', async () => {
    const pulled = await pull({
      'org.opencontainers.image.base.name': 'mirror.gcr.io/library/ubuntu:latest',
      'org.opencontainers.image.base.digest': 'sha256:base',
    });

    expect(pulled.Source?.base).toEqual({ name: 'mirror.gcr.io/library/ubuntu:latest', digest: 'sha256:base' });
  });
});
