import axios, { AxiosError, AxiosHeaders, InternalAxiosRequestConfig } from 'axios';
import { lastValueFrom, of, Subject, toArray } from 'rxjs';
import { Readable } from 'stream';
import {
  RETRY,
  Transfer,
  TransferEvent,
  External,
  ImageManifest,
  sourceHeaders,
  Upload,
} from '../../../src/api/internal/transfer';
import { HttpHeaders } from '../../../src/proxy/http';
import { ROWDY_LAYERS } from '../../../src/api/internal/layers';
import { Logger, Rowdy } from '@scaffoldly/rowdy';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

describe('upload', () => {
  const timing = { ...RETRY };
  beforeAll(() => Object.assign(RETRY, { minTimeout: 1, maxTimeout: 1 }));
  afterAll(() => Object.assign(RETRY, timing));

  const config = (): InternalAxiosRequestConfig => ({ headers: new AxiosHeaders(), method: 'get', url: 'https://x/' });
  const response = (status: number, headers: Record<string, string> = {}): unknown => ({
    status,
    statusText: '',
    data: Readable.from(['x']),
    headers: new AxiosHeaders(headers),
    config: config(),
  });
  const failure = (status?: number): AxiosError =>
    new AxiosError(
      'failed',
      status ? 'ERR_BAD_RESPONSE' : 'ECONNRESET',
      config(),
      null,
      status ? { status, statusText: '', data: '', headers: {}, config: config() } : undefined
    );

  const mocks = () => ({
    head: jest.fn().mockResolvedValue(response(404)),
    post: jest.fn().mockResolvedValue(response(202, { location: 'https://ecr.example/upload' })),
    get: jest.fn().mockResolvedValue(response(200)),
    patch: jest.fn().mockResolvedValue(response(202)),
    put: jest.fn().mockResolvedValue(response(201)),
  });

  const upload = (
    http: ReturnType<typeof mocks>,
    type: 'blob' | 'manifest' = 'blob',
    content?: Buffer,
    log: Logger = new Logger()
  ): Upload =>
    new Upload(
      {
        log,
        http,
        toHeaders: HttpHeaders.fromAxios(new AxiosHeaders()),
        fromHeaders: HttpHeaders.fromAxios(new AxiosHeaders()),
        manifest: { url: 'https://mirror.gcr.io/v2/acme/app/manifests/latest' },
        registry: { registry: 'ecr.example' },
      } as unknown as Transfer,
      type,
      { digest: 'sha256:abc', size: 1, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' },
      content
    );

  const run = (u: Upload): Promise<unknown> => lastValueFrom(Upload.observe([u]));

  it.each([404, 429, 503, undefined])('retries a source download that fails with %s', async (status) => {
    const http = mocks();
    http.get.mockRejectedValueOnce(failure(status)).mockRejectedValueOnce(failure(status));

    await run(upload(http));

    expect(http.get).toHaveBeenCalledTimes(3);
    expect(http.patch).toHaveBeenCalledTimes(1);
  });

  it('gives up on a source download that keeps failing', async () => {
    const http = mocks();
    http.get.mockRejectedValue(failure(404));

    await expect(run(upload(http))).rejects.toThrow('failed');

    expect(http.get).toHaveBeenCalledTimes(RETRY.retries + 1);
  });

  it('does not retry a source download the registry refuses', async () => {
    const http = mocks();
    http.get.mockRejectedValue(failure(403));

    await expect(run(upload(http))).rejects.toThrow('failed');

    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it.each(['head', 'post'] as const)('retries a %s the registry fails', async (method) => {
    const http = mocks();
    http[method].mockRejectedValueOnce(failure(503));

    await run(upload(http));

    expect(http[method]).toHaveBeenCalledTimes(2);
  });

  it('retries a post that loses its connection', async () => {
    const http = mocks();
    http.post.mockRejectedValueOnce(failure());

    await run(upload(http));

    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it.each(['head', 'post'] as const)('does not retry a %s that 403s', async (method) => {
    const http = mocks();
    http[method].mockRejectedValue(failure(403));

    await expect(run(upload(http))).rejects.toThrow('Upload failed');

    expect(http[method]).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error without a status', async () => {
    const http = mocks();
    http.head.mockRejectedValue(new TypeError('boom'));

    await expect(run(upload(http))).rejects.toThrow('boom');

    expect(http.head).toHaveBeenCalledTimes(1);
  });

  it('does not retry a patch of a consumed stream', async () => {
    const http = mocks();
    http.patch.mockRejectedValue(failure(503));

    await expect(run(upload(http))).rejects.toThrow('Upload failed');

    expect(http.patch).toHaveBeenCalledTimes(1);
  });

  it('retries a put of a buffer', async () => {
    const http = mocks();
    http.put.mockRejectedValueOnce(failure(503));

    await run(upload(http, 'manifest', Buffer.from('{}')));

    expect(http.put).toHaveBeenCalledTimes(2);
  });

  describe('image manifest', () => {
    const collect = (http: ReturnType<typeof mocks>): Promise<unknown> =>
      lastValueFrom(of('acme/app').pipe(Transfer.normalize(), Transfer.collect(new Logger(), http as never)));

    it.each([404, 429, 503, undefined])('retries a manifest that fails with %s', async (status) => {
      const http = mocks();
      http.get
        .mockRejectedValueOnce(failure(status))
        .mockRejectedValueOnce(failure(status))
        .mockRejectedValue(failure(403));

      await expect(collect(http)).rejects.toThrow('failed');

      expect(http.get).toHaveBeenCalledTimes(3);
    });

    it('gives up on a manifest that keeps failing', async () => {
      const http = mocks();
      http.get.mockRejectedValue(failure(404));

      await expect(collect(http)).rejects.toThrow('failed');

      expect(http.get).toHaveBeenCalledTimes(RETRY.retries + 1);
    });
  });

  describe('transfer complete', () => {
    const transfer = (http: ReturnType<typeof mocks>, log: Logger): Transfer => {
      const u = upload(http, 'blob', undefined, log);
      return { uploads: [[u]], _uploads: [[u]] } as unknown as Transfer;
    };

    it('logs on success', async () => {
      const log = new Logger();
      const info = jest.spyOn(log, 'info');

      await lastValueFrom(of(transfer(mocks(), log)).pipe(Transfer.upload(log, mocks() as never)));

      expect(info).toHaveBeenCalledWith(expect.stringContaining('Transfer complete'));
    });

    it('stays silent on failure', async () => {
      const log = new Logger();
      const info = jest.spyOn(log, 'info');
      const http = mocks();
      http.get.mockRejectedValue(failure(403));

      await expect(
        lastValueFrom(of(transfer(http, log)).pipe(Transfer.upload(log, mocks() as never)))
      ).rejects.toThrow();

      expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Transfer complete'));
    });
  });
});

describe('transfers', () => {
  const logger = new Logger();
  const rowdy = new Rowdy(logger, new AbortController().signal);
  const aws = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? it : it.skip;

  describe('normalize', () => {
    const tests = [
      {
        image: 'ubuntu',
        normalized: {
          image: 'mirror.gcr.io/library/ubuntu:latest',
          registry: 'mirror.gcr.io',
          slug: 'library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'latest',
          tags: ['latest'],
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/latest',
        },
      },
      {
        image: 'ubuntu@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
        normalized: {
          image: 'mirror.gcr.io/library/ubuntu@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
          registry: 'mirror.gcr.io',
          slug: 'library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
          tags: ['untagged-4cb780d5'],
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
        },
      },
      {
        image: 'ubuntu:latest',
        normalized: {
          image: 'mirror.gcr.io/library/ubuntu:latest',
          registry: 'mirror.gcr.io',
          slug: 'library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'latest',
          tags: ['latest'],
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/latest',
        },
      },
      {
        image: 'library/ubuntu',
        normalized: {
          image: 'mirror.gcr.io/library/ubuntu:latest',
          registry: 'mirror.gcr.io',
          slug: 'library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'latest',
          tags: ['latest'],
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/latest',
        },
      },
      {
        image: 'library/ubuntu:latest',
        normalized: {
          image: 'mirror.gcr.io/library/ubuntu:latest',
          registry: 'mirror.gcr.io',
          slug: 'library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'latest',
          tags: ['latest'],
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/latest',
        },
      },
      {
        image: 'library/ubuntu@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
        normalized: {
          image: 'mirror.gcr.io/library/ubuntu@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
          registry: 'mirror.gcr.io',
          slug: 'library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
          tags: ['untagged-4cb780d5'],
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
        },
      },
      {
        image: 'registry-1.docker.io/library/ubuntu:latest',
        normalized: {
          image: 'registry-1.docker.io/library/ubuntu:latest',
          registry: 'registry-1.docker.io',
          slug: 'library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'latest',
          tags: ['latest'],
          url: 'https://registry-1.docker.io/v2/library/ubuntu/manifests/latest',
        },
      },
      {
        image:
          'registry-1.docker.io/library/ubuntu@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
        normalized: {
          image:
            'registry-1.docker.io/library/ubuntu@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
          registry: 'registry-1.docker.io',
          slug: 'library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
          tags: ['untagged-4cb780d5'],
          url: 'https://registry-1.docker.io/v2/library/ubuntu/manifests/sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
        },
      },
      {
        image: 'public.ecr.aws/ubuntu/ubuntu:latest',
        normalized: {
          image: 'public.ecr.aws/ubuntu/ubuntu:latest',
          registry: 'public.ecr.aws',
          slug: 'ubuntu/ubuntu',
          namespace: 'ubuntu',
          name: 'ubuntu',
          digest: 'latest',
          tags: ['latest'],
          url: 'https://public.ecr.aws/v2/ubuntu/ubuntu/manifests/latest',
        },
      },
      {
        image: 'public.ecr.aws/docker/library/ubuntu:latest',
        normalized: {
          image: 'public.ecr.aws/docker/library/ubuntu:latest',
          registry: 'public.ecr.aws',
          slug: 'docker/library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'latest',
          tags: ['latest'],
          url: 'https://public.ecr.aws/v2/docker/library/ubuntu/manifests/latest',
        },
      },
      {
        image: 'mirror.gcr.io/library/ubuntu:noble-20251001',
        normalized: {
          image: 'mirror.gcr.io/library/ubuntu:noble-20251001',
          registry: 'mirror.gcr.io',
          slug: 'library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'noble-20251001',
          tags: ['noble-20251001'],
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/noble-20251001',
        },
      },
      {
        image: 'ubuntu:noble@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
        normalized: {
          image:
            'mirror.gcr.io/library/ubuntu:noble@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
          registry: 'mirror.gcr.io',
          slug: 'library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
          tags: ['noble'],
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
        },
      },
      {
        image: 'ghcr.io/cnuss/nuss-io:rowdy@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
        normalized: {
          image: 'ghcr.io/cnuss/nuss-io:rowdy@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
          registry: 'ghcr.io',
          slug: 'cnuss/nuss-io',
          namespace: 'cnuss',
          name: 'nuss-io',
          digest: 'sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
          tags: ['rowdy'],
          url: 'https://ghcr.io/v2/cnuss/nuss-io/manifests/sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
        },
      },
      {
        image: 'localhost:5000/acme/app:v1@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
        normalized: {
          image: 'localhost:5000/acme/app:v1@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
          registry: 'localhost:5000',
          slug: 'acme/app',
          namespace: 'acme',
          name: 'app',
          digest: 'sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
          tags: ['v1'],
          url: 'https://localhost:5000/v2/acme/app/manifests/sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
        },
      },
    ];

    tests.forEach(({ image, normalized }) => {
      it(`should normalize ${image}`, async () => {
        const result = await lastValueFrom(of(image).pipe(Transfer.normalize()));
        expect(result).toEqual(normalized);
      });
    });
  });

  describe('collect', () => {
    const tests = [
      {
        normalized: {
          image: 'mirror.gcr.io/library/ubuntu:noble-20251001',
          registry: 'mirror.gcr.io',
          slug: 'library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'noble-20251001',
          tags: ['noble-20251001'],
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/noble-20251001',
        },
        collected: {
          index: JSON.parse(
            readFileSync(`${__dirname}/ubuntu:noble-20251001.index.json`, 'utf-8')
          ) as External['Index'],
          images: JSON.parse(
            readFileSync(`${__dirname}/ubuntu:noble-20251001.images.json`, 'utf-8')
          ) as ImageManifest['images'],
          tags: ['noble-20251001'],
        },
      },
      {
        normalized: {
          image: 'mirror.gcr.io/library/alpine:20250108',
          registry: 'mirror.gcr.io',
          slug: 'library/alpine',
          namespace: 'library',
          name: 'alpine',
          digest: '20250108',
          tags: ['20250108'],
          url: 'https://mirror.gcr.io/v2/library/alpine/manifests/20250108',
        },
        collected: {
          index: JSON.parse(readFileSync(`${__dirname}/alpine:20250108.index.json`, 'utf-8')) as External['Index'],
          images: JSON.parse(
            readFileSync(`${__dirname}/alpine:20250108.images.json`, 'utf-8')
          ) as ImageManifest['images'],
          tags: ['20250108'],
        },
      },
      {
        normalized: {
          image: 'ghcr.io/scaffoldly/scratch:sha-4d8e686',
          registry: 'ghcr.io',
          slug: 'scaffoldly/scratch',
          namespace: 'scaffoldly',
          name: 'scratch',
          digest: 'sha-4d8e686',
          tags: ['sha-4d8e686'],
          url: 'https://ghcr.io/v2/scaffoldly/scratch/manifests/sha-4d8e686',
        },
        collected: {
          index: JSON.parse(readFileSync(`${__dirname}/scratch:sha-4d8e686.index.json`, 'utf-8')) as External['Index'],
          images: JSON.parse(
            readFileSync(`${__dirname}/scratch:sha-4d8e686.images.json`, 'utf-8')
          ) as ImageManifest['images'],
          tags: ['sha-4d8e686'],
        },
      },
    ];

    it('should keep layers and config rootfs.diff_ids aligned when injecting layersFrom (issue #5)', async () => {
      const result = await lastValueFrom(
        of('mirror.gcr.io/library/busybox:latest').pipe(
          Transfer.normalize(),
          Transfer.collect(logger, rowdy.http, [ROWDY_LAYERS])
        )
      );

      // At least one platform must have had layers injected
      const injected = result.images.filter((img) => !!img.config);
      expect(injected.length).toBeGreaterThan(0);

      for (const img of injected) {
        const config = JSON.parse(img.config!.toString('utf-8')) as External['Config'];
        // The rewritten config blob's digest/size must match what the manifest points at
        const digest = `sha256:${createHash('sha256').update(img.config!).digest('hex')}`;
        expect(img.image.config!.digest).toBe(digest);
        expect(img.image.config!.size).toBe(img.config!.length);
        // The core invariant: one diff_id per manifest layer
        expect(img.image.layers!.length).toBe(config.rootfs!.diff_ids!.length);
      }
    }, 60000);

    describe('layers-from', () => {
      it("reads a layers-from blob without the app image's credentials", () => {
        const app = HttpHeaders.from({ authorization: 'Basic c2VjcmV0', accept: 'application/json' });
        const ref = { annotations: { 'run.rowdy.index.url': 'https://ghcr.io/v2/scaffoldly/rowdy/manifests/beta' } };
        expect(sourceHeaders(app, ref).get('authorization')).toBeUndefined();
        expect(sourceHeaders(app, {}).get('authorization')).toBe('Basic c2VjcmV0');
      });

      const busybox = 'mirror.gcr.io/library/busybox:latest';
      const TUNNELD = 'ghcr.io/tunnel-pizza/tunneld:latest';
      const platformOf = (img: ImageManifest['images'][number]): string =>
        `${img.manifest.platform?.os}/${img.manifest.platform?.architecture}`;

      it('reads a layers-from blob anonymously from its own registry', async () => {
        const source = await lastValueFrom(Transfer.source(logger, rowdy.http, ROWDY_LAYERS));
        const layer = source.manifest.images[0]!.image.layers![0]!;
        const url = `${source.manifest.url.split('/').slice(0, -2).join('/')}/blobs/${layer.digest}`;
        const ref = { ...layer, annotations: { 'run.rowdy.index.url': source.manifest.url } };
        const app = HttpHeaders.from({ authorization: 'Bearer not-for-this-registry' });
        const response = await rowdy.http.head(url, { headers: sourceHeaders(app, ref).intoAxios() });
        expect(response.status).toBe(200);
      }, 120000);

      it('checks rowdy:beta as a layers-from source', async () => {
        const source = await lastValueFrom(Transfer.source(logger, rowdy.http, ROWDY_LAYERS));
        expect(source.from).toBe(ROWDY_LAYERS);
        expect(source.configs.size).toBeGreaterThanOrEqual(2);
      }, 120000);

      it('accepts a third-party source built like rowdy', async () => {
        const source = await lastValueFrom(Transfer.source(logger, rowdy.http, TUNNELD));
        expect(source.configs.size).toBeGreaterThanOrEqual(2);
      }, 120000);

      it('refuses a source that is more than one layer', async () => {
        await expect(
          lastValueFrom(Transfer.source(logger, rowdy.http, 'mirror.gcr.io/library/nginx:alpine'))
        ).rejects.toThrow(/layers-from mirror.gcr.io\/library\/nginx:alpine \(linux\/[^)]+\): \d+ layers/);
      }, 120000);

      describe('collected with two sources', () => {
        let plain: ImageManifest;
        let layered: ImageManifest;

        beforeAll(async () => {
          plain = await lastValueFrom(of(busybox).pipe(Transfer.normalize(), Transfer.collect(logger, rowdy.http)));
          layered = await lastValueFrom(
            of(busybox).pipe(Transfer.normalize(), Transfer.collect(logger, rowdy.http, [TUNNELD, ROWDY_LAYERS]))
          );
        }, 120000);

        const appLayers = (digest?: string): number =>
          plain.images.find((img) => img.manifest.digest === digest)?.image.layers?.length ?? -1;

        it("injects every source's layer in order, rowdy last", () => {
          const injected = layered.images.filter((img) => !!img.config);
          expect(injected.length).toBeGreaterThanOrEqual(2);
          for (const img of injected) {
            const layers = img.image.layers!;
            const config = JSON.parse(img.config!.toString('utf-8')) as External['Config'];
            expect(layers.length).toBe(appLayers(img.manifest.digest) + 2);
            const [tunneld, rowdyLayer] = layers.slice(-2);
            expect(tunneld!.annotations?.['run.rowdy.index.url']).toContain('tunnel-pizza/tunneld');
            expect(rowdyLayer!.annotations?.['run.rowdy.index.url']).toContain('scaffoldly/rowdy');
            expect(config.rootfs!.diff_ids!.length).toBe(layers.length);
            expect(config.history!.filter((h) => h.empty_layer !== true).length).toBe(layers.length);
          }
        });

        it('copies a platform no source publishes unchanged', () => {
          const i386 = layered.images.find((img) => platformOf(img) === 'linux/386');
          expect(i386).toBeDefined();
          expect(i386!.config).toBeUndefined();
          expect(i386!.image.layers!.length).toBe(appLayers(i386!.manifest.digest));
        });
      });
    });

    tests.forEach(({ normalized, collected }) => {
      it(`should collect manifests for ${normalized.image}`, async () => {
        const result = await lastValueFrom(of(normalized).pipe(Transfer.collect(logger, rowdy.http)));
        // hack to write files when updating tests
        // writeFileSync(
        //   `${__dirname}/${normalized.name}:${normalized.digest}.index.json`,
        //   JSON.stringify(result.index, null, 2)
        // );
        // writeFileSync(
        //   `${__dirname}/${normalized.name}:${normalized.digest}.images.json`,
        //   JSON.stringify(result.images, null, 2)
        // );
        // expect(true).toBe(false);
        expect(JSON.parse(JSON.stringify(result.index))).toEqual(JSON.parse(JSON.stringify(collected.index)));
        expect(result.images.length).toEqual(collected.images.length);
        expect(result.images.sort((a, b) => a.image.config!.digest!.localeCompare(b.image.config!.digest!))).toEqual(
          collected.images.sort((a, b) => a.image.config!.digest!.localeCompare(b.image.config!.digest!))
        );
      });
    });
  });

  describe('prepare', () => {
    const tests = [
      {
        normalized: {
          image: 'mirror.gcr.io/library/ubuntu:noble-20251001',
          registry: 'mirror.gcr.io',
          slug: 'library/ubuntu',
          namespace: 'library',
          name: 'ubuntu',
          digest: 'noble-20251001',
          tags: ['noble-20251001'],
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/noble-20251001',
        },
      },
    ];

    describe('aws', () => {
      tests.forEach(({ normalized }) => {
        aws(`should prepare manifests for ${normalized.image}`, async () => {
          const prepared = await lastValueFrom(
            of(normalized).pipe(
              Transfer.collect(logger, rowdy.http),
              Transfer.prepare(logger, rowdy.http, rowdy.registry)
            )
          );
          expect(prepared).toBeDefined();

          const uploads = await lastValueFrom(prepared.uploads.pipe(toArray()));
          expect(uploads.length).toBe(4);

          // Configs (as blobs)
          expect(uploads[0]?.length).toBe(12);
          expect(new Set(uploads[0]?.map((upload) => upload.fromUrl.split('sha256:')[0]))).toEqual(
            new Set([`https://${normalized.registry}/v2/${normalized.namespace}/${normalized.name}/blobs/`])
          );

          // Layers (as blobs)
          expect(uploads[1]?.length).toBe(12);
          expect(new Set(uploads[1]?.map((upload) => upload.fromUrl.split('sha256:')[0]))).toEqual(
            new Set([`https://${normalized.registry}/v2/${normalized.namespace}/${normalized.name}/blobs/`])
          );
          expect(new Set(uploads[1]?.map((upload) => upload.toUrl)).size).toBe(1);
          expect([...new Set(uploads[1]?.map((upload) => upload.toUrl))][0]).toMatch(
            RegExp(
              `^https://[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/v2/${normalized.namespace}/${normalized.name}/blobs/uploads/`
            )
          );

          // Image Manfiests
          expect(uploads[2]?.length).toBe(12);
          expect(new Set(uploads[2]?.map((upload) => upload.fromUrl.split('sha256:')[0]))).toEqual(
            new Set(['https://mirror.gcr.io/v2/library/ubuntu/manifests/'])
          );
          expect(uploads[2]?.map((upload) => upload.toUrl).length).toBe(12);
          for (const upload of uploads[2]!) {
            expect(upload.toUrl).toMatch(
              RegExp(
                `^https://[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/v2/${normalized.namespace}/${normalized.name}/manifests/`
              )
            );
          }

          // Indexes
          expect(uploads[3]?.length).toBe(1);
          expect(uploads[3]?.[0]?.fromUrl).toBe(normalized.url);
          expect(uploads[3]?.[0]?.toUrl).toMatch(
            RegExp(
              `^https://[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/v2/${normalized.namespace}/${normalized.name}/manifests/${normalized.tags[0]}$`
            )
          );
        });
      });
    });
  });

  describe('transfer', () => {
    const tests = [
      {
        // TODO: make a test to pull a sha256 digest
        normalized: {
          image: 'mirror.gcr.io/library/alpine:latest',
          registry: 'mirror.gcr.io',
          slug: 'library/alpine',
          namespace: 'library',
          name: 'alpine',
          digest: 'latest',
          tags: ['latest'],
          url: 'https://mirror.gcr.io/v2/library/alpine/manifests/latest',
        },
        uploaded: {
          code: 200,
          imageRef: /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/alpine:latest$/,
        },
      },
    ];

    describe('aws', () => {
      tests.forEach(({ normalized, uploaded }) => {
        aws(`should transfer ${normalized.name}`, async () => {
          const result = await lastValueFrom(
            of(normalized).pipe(
              Transfer.collect(logger, rowdy.http),
              Transfer.prepare(logger, rowdy.http, rowdy.registry),
              Transfer.upload(logger, rowdy.http)
            )
          );
          expect(result).toBeDefined();
          expect(result.code).toBe(uploaded.code);
          expect(result.reasons).toEqual([]);
          expect(result.imageRef()).toMatch(uploaded.imageRef);
          expect(result.command).toEqual(['/bin/sh']);
          expect(result.entrypoint).toBeUndefined();
          expect(result.workdir).toBe('/');
        });
      });
    });
  });
});

describe('Transfer.upload events', () => {
  const transfer = new (Transfer as unknown as new (...args: unknown[]) => Transfer)();
  const log = new Logger('test');

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => jest.useRealTimers());

  const uploading = (): { source: Subject<Transfer>; events: TransferEvent[] } => {
    const source = new Subject<Transfer>();
    const events: TransferEvent[] = [];
    source.pipe(Transfer.upload(log, axios, { next: (event) => events.push(event) })).subscribe({ error: () => {} });
    return { source, events };
  };

  const summary = '0/0 transfers: 100% complete';

  it('reports progress when it changes, not every tick', () => {
    const { source, events } = uploading();

    source.next(transfer);
    jest.advanceTimersByTime(3000);

    expect(events).toEqual([{ lifecycle: 'copying', summary }]);
  });

  it('reports the end of a copy', () => {
    const { source, events } = uploading();

    source.next(transfer);
    source.complete();

    expect(events).toEqual([{ lifecycle: 'copied', summary }]);
  });

  it('reports a failed copy', () => {
    const { source, events } = uploading();

    source.next(transfer);
    source.error(new Error('denied'));

    expect(events).toEqual([{ lifecycle: 'failed', summary }]);
  });

  it('needs no stream to report to', () => {
    const source = new Subject<Transfer>();

    source.pipe(Transfer.upload(log, axios)).subscribe();
    source.next(transfer);

    expect(() => source.complete()).not.toThrow();
  });
});
