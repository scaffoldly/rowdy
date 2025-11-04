import { lastValueFrom, of } from 'rxjs';
import { Transfer } from '../../../src/api/internal/transfer';
import { Logger, Rowdy } from '@scaffoldly/rowdy';

describe('transfers', () => {
  const logger = new Logger();
  const rowdy = new Rowdy(logger, new AbortController().signal);

  describe('normalizeImage', () => {
    const tests = [
      {
        image: 'ubuntu',
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
        image: 'ubuntu@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
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
        image: 'ubuntu:latest',
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
        image: 'library/ubuntu',
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
        image: 'library/ubuntu:latest',
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
        image: 'library/ubuntu@sha256:4cb780d50443fc4463f1f9360c03ca46512e4fdd8fd97c5ce7e69c8758924575',
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

  describe('collectManifests', () => {
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
        manifest: {
          url: 'https://mirror.gcr.io/v2/library/ubuntu/manifests/noble-20251001',
          digest: 'sha256:66460d557b25769b102175144d538d88219c077c678a49af4afca6fbfc1b5252',
          tag: 'noble-20251001',
          images: 12,
          configDigests: [
            'sha256:206b60b2588d4a4f16e933f112a1895644a9d63355ce129aeb3d8eb55acba2db',
            'sha256:3b3add7a015eddabe1f8fcb39ffae7def926f67474b3bba47cba0137f343e6a7',
            'sha256:5e5a000d140d605ff9f495bddfd11d058cf6c05e8d7273126dcd49125531bd57',
            'sha256:678eefd3f420a76c197da434f174d734b80fffa52cccc288bb4cd763c8765e5a',
            'sha256:6c6c88baf206d4cc59be6f6718e922fb25b986830bc36b0b699e2299020f8f10',
            'sha256:7bcf37e8ebffb1b727d122f48aed67b0c36c6ec2ea720a6ada3ebfc61b43497e',
            'sha256:97bed23a34971024aa8d254abbe67b7168772340d1f494034773bc464e8dd5b6',
            'sha256:a7de31bf4341df28f1ad4fe295b287c20d823cd474e081bf4e2945eeac8d7f61',
            'sha256:ae5abc725ed95926e2a20319ce3534f7cb6f9dc21fd6d295f1ea4549f6564fda',
            'sha256:bec01dfa80e941897d62ca44df1d8b2bde550f5cc4efdfa308170d51e44b1e61',
            'sha256:d2c6794a73446c2c200bc221c928576fdf5749d32c7065dfb58fa63e9613810f',
            'sha256:e149199029d15548c4f6d2666e88879360381a2be8a1b747412e3fe91fb1d19d',
          ],
          layerDigests: [
            'sha256:199e3830c89a37cc6980743d7c9e0e355251d050c55eb838183c9cf64fac375b',
            'sha256:4afa85c5883c0db62b02025c149edaaa237af5ba25ea48039e875a802d465ac7',
            'sha256:4b3ffd8ccb5201a0fc03585952effb4ed2d1ea5e704d2e7330212fb8b16c86a3',
            'sha256:5f8acbb3bc13c395a998825f929d1be67ccbbc4782d2b8506b822539a77b6372',
            'sha256:67735b72a65d308a2c2c9505d0d6e8419b7f2654a16cbd56963d88e01202d507',
            'sha256:7bae66667b7b05f43acd806d2488878773ca10f1fa2b2e295c67569ef92f900e',
            'sha256:98cd13f94b85280da21158e1110c44b19a11fb793fd943cb453d8198903f6121',
            'sha256:b8a35db46e38ce87d4e743e1265ff436ed36e01d23246b24a1cbbeaae18ec432',
            'sha256:ba223669755123cecd0bc56e1d52fca1436cf70df4b22d34ba5b4ece9f391de7',
            'sha256:e00a0c4a81b2457fe157d12fd1f48ca2b559fe05de7f26993d35247448840b0a',
            'sha256:f083401df72b3a565a0863d6b77b25bd0b6e64e17e689b530fd1f15055ef0c7b',
            'sha256:ff47a256ba51b80e9880bc96be4ac2f094c47e0fcd7eec71bab85787cfa54b8b',
          ],
        },
      },
    ];

    tests.forEach(({ normalized, manifest }) => {
      it(`should collect manifests for ${normalized.image}`, async () => {
        const result = await lastValueFrom(of(normalized).pipe(Transfer.collect(logger, rowdy.http)));
        expect(result.digest).toBe(manifest.digest);
        expect(result.tag).toBe(manifest.tag);
        expect(result.url).toBe(manifest.url);
        expect(result.index.manifests!.length).toBe(manifest.images);
        expect(result.images.length).toBe(manifest.images);
        expect(result.images.map((img) => img.config?.digest).sort()).toEqual(manifest.configDigests);
        expect(
          result.images
            .map((img) => img.layers?.map((l) => l.digest))
            .flat()
            .sort()
        ).toEqual(manifest.layerDigests);
      });
    });
  });
});
