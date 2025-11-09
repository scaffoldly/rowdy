import { lastValueFrom, of, toArray } from 'rxjs';
import { Transfer, External } from '../../../src/api/internal/transfer';
import { Logger, Rowdy } from '@scaffoldly/rowdy';
import { readFileSync } from 'fs';

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
          tag: 'latest',
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
          tag: null,
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
          tag: 'latest',
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
          tag: 'latest',
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
          tag: 'latest',
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
          tag: null,
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
          tag: 'latest',
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
          tag: null,
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
          tag: 'latest',
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
          tag: 'latest',
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
          tag: 'noble-20251001',
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/noble-20251001',
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
          tag: 'noble-20251001',
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/noble-20251001',
        },
        collected: {
          index: JSON.parse(
            readFileSync(`${__dirname}/ubuntu:noble-20251001.index.json`, 'utf-8')
          ) as External['Index'],
          images: JSON.parse(
            readFileSync(`${__dirname}/ubuntu:noble-20251001.images.json`, 'utf-8')
          ) as External['ImageManifest'][],
        },
        headers: {
          headers: {
            accept: [
              'application/vnd.oci.image.index.v1+json',
              'application/vnd.docker.distribution.manifest.list.v2+json',
              'application/vnd.oci.image.manifest.v1+json',
              'application/vnd.docker.distribution.manifest.v2+json',
            ],
          },
        },
      },
    ];

    tests.forEach(({ normalized, collected }) => {
      it(`should collect manifests for ${normalized.image}`, async () => {
        const result = await lastValueFrom(of(normalized).pipe(Transfer.collect(logger, rowdy.http)));
        expect(JSON.parse(JSON.stringify(result.index))).toEqual(JSON.parse(JSON.stringify(collected.index)));
        expect(result.images.length).toEqual(collected.images.length);
        expect(result.images.sort((a, b) => a.config!.digest!.localeCompare(b.config!.digest!))).toEqual(
          collected.images.sort((a, b) => a.config!.digest!.localeCompare(b.config!.digest!))
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
          tag: 'noble-20251001',
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
          expect(uploads.length).toBe(3);

          // Blobs
          expect(uploads[0]?.length).toBe(24);
          expect(new Set(uploads[0]?.map((upload) => upload.fromUrl.split('sha256:')[0]))).toEqual(
            new Set([`https://${normalized.registry}/v2/${normalized.namespace}/${normalized.name}/blobs/`])
          );
          expect(new Set(uploads[0]?.map((upload) => upload.toUrl)).size).toBe(1);
          expect([...new Set(uploads[0]?.map((upload) => upload.toUrl))][0]).toMatch(
            RegExp(
              `^https://[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/v2/${normalized.namespace}/${normalized.name}/blobs/uploads/`
            )
          );

          // Image Manfiests
          expect(uploads[1]?.length).toBe(12);
          expect(new Set(uploads[1]?.map((upload) => upload.fromUrl.split('sha256:')[0]))).toEqual(
            new Set(['https://mirror.gcr.io/v2/library/ubuntu/manifests/'])
          );
          expect(uploads[1]?.map((upload) => upload.toUrl).length).toBe(12);
          for (const upload of uploads[1]!) {
            expect(upload.toUrl).toMatch(
              RegExp(
                `^https://[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/v2/${normalized.namespace}/${normalized.name}/manifests/`
              )
            );
          }

          // Indexes
          expect(uploads[2]?.length).toBe(1);
          expect(uploads[2]?.[0]?.fromUrl).toBe(normalized.url);
          expect(uploads[2]?.[0]?.toUrl).toMatch(
            RegExp(
              `^https://[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/v2/${normalized.namespace}/${normalized.name}/manifests/${normalized.tag}$`
            )
          );
        });
      });
    });
  });

  describe('transfer', () => {
    const tests = [
      {
        normalized: {
          image: 'mirror.gcr.io/library/alpine:20250108',
          registry: 'mirror.gcr.io',
          slug: 'library/alpine',
          namespace: 'library',
          name: 'alpine',
          digest: '20250108',
          tag: '20250108',
          url: 'https://mirror.gcr.io/v2/library/alpine/manifests/20250108',
        },
        uploaded: {
          code: 200,
          imageRef:
            /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/library\/alpine@sha256:115729ec5cb049ba6359c3ab005ac742012d92bbaa5b8bc1a878f1e8f62c0cb8$/,
        },
      },
    ];

    describe('aws', () => {
      tests.forEach(({ normalized, uploaded }) => {
        aws(`should transfer ${normalized.image}`, async () => {
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
          expect(result.imageRef).toMatch(uploaded.imageRef);
        });
      });
    });
  });
});
