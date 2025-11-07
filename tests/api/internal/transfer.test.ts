import { lastValueFrom, of, toArray } from 'rxjs';
import { Transfer } from '../../../src/api/internal/transfer';
import { Logger, Rowdy } from '@scaffoldly/rowdy';

describe('transfers', () => {
  const logger = new Logger();
  const rowdy = new Rowdy(logger, new AbortController().signal);
  const aws = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? it : it.skip;

  describe('normalize', () => {
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
          index: {
            manifests: [
              {
                annotations: {
                  'com.docker.official-images.bashbrew.arch': 'amd64',
                  'org.opencontainers.image.base.name': 'scratch',
                  'org.opencontainers.image.created': '2025-10-01T00:00:00Z',
                  'org.opencontainers.image.revision': 'f5b85bb809ca07067994b7b0ec661a31718d6c75',
                  'org.opencontainers.image.source': 'https://git.launchpad.net/cloud-images/+oci/ubuntu-base',
                  'org.opencontainers.image.url': 'https://hub.docker.com/_/ubuntu',
                  'org.opencontainers.image.version': '24.04',
                },
                digest: 'sha256:d22e4fb389065efa4a61bb36416768698ef6d955fe8a7e0cdb3cd6de80fa7eec',
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  architecture: 'amd64',
                  os: 'linux',
                },
                size: 424,
              },
              {
                annotations: {
                  'com.docker.official-images.bashbrew.arch': 'amd64',
                  'vnd.docker.reference.digest':
                    'sha256:d22e4fb389065efa4a61bb36416768698ef6d955fe8a7e0cdb3cd6de80fa7eec',
                  'vnd.docker.reference.type': 'attestation-manifest',
                },
                digest: 'sha256:ceb72b44d89ee266fa1249ab5bc801165fea91d8555b648cb8a9f8fe8fbd2901',
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  architecture: 'unknown',
                  os: 'unknown',
                },
                size: 562,
              },
              {
                annotations: {
                  'com.docker.official-images.bashbrew.arch': 'arm32v7',
                  'org.opencontainers.image.base.name': 'scratch',
                  'org.opencontainers.image.created': '2025-10-01T00:00:00Z',
                  'org.opencontainers.image.revision': 'f6aaa3edd17b6b9b312fc98d5d48c34d6c391f12',
                  'org.opencontainers.image.source': 'https://git.launchpad.net/cloud-images/+oci/ubuntu-base',
                  'org.opencontainers.image.url': 'https://hub.docker.com/_/ubuntu',
                  'org.opencontainers.image.version': '24.04',
                },
                digest: 'sha256:254ac4961ea10df8ceb1301f46d213f26d397fbd17f190b797d221f79dd7ab83',
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  architecture: 'arm',
                  os: 'linux',
                  variant: 'v7',
                },
                size: 424,
              },
              {
                annotations: {
                  'com.docker.official-images.bashbrew.arch': 'arm32v7',
                  'vnd.docker.reference.digest':
                    'sha256:254ac4961ea10df8ceb1301f46d213f26d397fbd17f190b797d221f79dd7ab83',
                  'vnd.docker.reference.type': 'attestation-manifest',
                },
                digest: 'sha256:cde13c4702611cf67ad18294d7a85d83175a1df055c716db714734d64b080885',
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  architecture: 'unknown',
                  os: 'unknown',
                },
                size: 562,
              },
              {
                annotations: {
                  'com.docker.official-images.bashbrew.arch': 'arm64v8',
                  'org.opencontainers.image.base.name': 'scratch',
                  'org.opencontainers.image.created': '2025-10-01T00:00:00Z',
                  'org.opencontainers.image.revision': '720df02de2a670250e237af7ca8a267bf4c2365c',
                  'org.opencontainers.image.source': 'https://git.launchpad.net/cloud-images/+oci/ubuntu-base',
                  'org.opencontainers.image.url': 'https://hub.docker.com/_/ubuntu',
                  'org.opencontainers.image.version': '24.04',
                },
                digest: 'sha256:3372ac029cdf2ade8c2f8373590af8ca6422e84b99bf62c60e8df2e3fa5ee7e7',
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  architecture: 'arm64',
                  os: 'linux',
                  variant: 'v8',
                },
                size: 424,
              },
              {
                annotations: {
                  'com.docker.official-images.bashbrew.arch': 'arm64v8',
                  'vnd.docker.reference.digest':
                    'sha256:3372ac029cdf2ade8c2f8373590af8ca6422e84b99bf62c60e8df2e3fa5ee7e7',
                  'vnd.docker.reference.type': 'attestation-manifest',
                },
                digest: 'sha256:7593ee2f112f25688cac8232b924608dea196121ebb491e5920650d45ea933b0',
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  architecture: 'unknown',
                  os: 'unknown',
                },
                size: 562,
              },
              {
                annotations: {
                  'com.docker.official-images.bashbrew.arch': 'ppc64le',
                  'org.opencontainers.image.base.name': 'scratch',
                  'org.opencontainers.image.created': '2025-10-01T00:00:00Z',
                  'org.opencontainers.image.revision': '98861af7f2b9964f9f6f9ebf375d4c61fbe6dfe5',
                  'org.opencontainers.image.source': 'https://git.launchpad.net/cloud-images/+oci/ubuntu-base',
                  'org.opencontainers.image.url': 'https://hub.docker.com/_/ubuntu',
                  'org.opencontainers.image.version': '24.04',
                },
                digest: 'sha256:063d9d6a632f2bd248b81bcc9ec06e1073b1adf7de993d9ac31dab5e364d3582',
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  architecture: 'ppc64le',
                  os: 'linux',
                },
                size: 424,
              },
              {
                annotations: {
                  'com.docker.official-images.bashbrew.arch': 'ppc64le',
                  'vnd.docker.reference.digest':
                    'sha256:063d9d6a632f2bd248b81bcc9ec06e1073b1adf7de993d9ac31dab5e364d3582',
                  'vnd.docker.reference.type': 'attestation-manifest',
                },
                digest: 'sha256:fc85f66b5a833130a2638f01b1c900495f7fcd3846dea6e665b43ae7616c6f25',
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  architecture: 'unknown',
                  os: 'unknown',
                },
                size: 562,
              },
              {
                annotations: {
                  'com.docker.official-images.bashbrew.arch': 'riscv64',
                  'org.opencontainers.image.base.name': 'scratch',
                  'org.opencontainers.image.created': '2025-10-01T00:00:00Z',
                  'org.opencontainers.image.revision': 'aeafe6c87cb5b8a86db9c4d26c67dbaf6cbc1833',
                  'org.opencontainers.image.source': 'https://git.launchpad.net/cloud-images/+oci/ubuntu-base',
                  'org.opencontainers.image.url': 'https://hub.docker.com/_/ubuntu',
                  'org.opencontainers.image.version': '24.04',
                },
                digest: 'sha256:754d01ad9a026a181f93900baff61941d5a90d1916a047f2bcdfe6cfba07c0a5',
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  architecture: 'riscv64',
                  os: 'linux',
                },
                size: 424,
              },
              {
                annotations: {
                  'com.docker.official-images.bashbrew.arch': 'riscv64',
                  'vnd.docker.reference.digest':
                    'sha256:754d01ad9a026a181f93900baff61941d5a90d1916a047f2bcdfe6cfba07c0a5',
                  'vnd.docker.reference.type': 'attestation-manifest',
                },
                digest: 'sha256:d8b13c2b5f5dbe01129312fdb57b70bea737ce02b6bb21bee9f388c66666a254',
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  architecture: 'unknown',
                  os: 'unknown',
                },
                size: 562,
              },
              {
                annotations: {
                  'com.docker.official-images.bashbrew.arch': 's390x',
                  'org.opencontainers.image.base.name': 'scratch',
                  'org.opencontainers.image.created': '2025-10-01T00:00:00Z',
                  'org.opencontainers.image.revision': 'ab94972ffb404f99fb8029018750490472afa023',
                  'org.opencontainers.image.source': 'https://git.launchpad.net/cloud-images/+oci/ubuntu-base',
                  'org.opencontainers.image.url': 'https://hub.docker.com/_/ubuntu',
                  'org.opencontainers.image.version': '24.04',
                },
                digest: 'sha256:b5f6e36f1ab500cbe168708acdb1a658e3e30d47508b645b081ca95f0464ee68',
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  architecture: 's390x',
                  os: 'linux',
                },
                size: 424,
              },
              {
                annotations: {
                  'com.docker.official-images.bashbrew.arch': 's390x',
                  'vnd.docker.reference.digest':
                    'sha256:b5f6e36f1ab500cbe168708acdb1a658e3e30d47508b645b081ca95f0464ee68',
                  'vnd.docker.reference.type': 'attestation-manifest',
                },
                digest: 'sha256:56573122a353cd1611f35f8321f7988f99ff3e7052e8595702cb6334eda2be9f',
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  architecture: 'unknown',
                  os: 'unknown',
                },
                size: 562,
              },
            ],
            mediaType: 'application/vnd.oci.image.index.v1+json',
            schemaVersion: 2,
          },
          images: [
            {
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              config: {
                mediaType: 'application/vnd.oci.image.config.v1+json',
                digest: 'sha256:206b60b2588d4a4f16e933f112a1895644a9d63355ce129aeb3d8eb55acba2db',
                size: 167,
              },
              layers: [
                {
                  mediaType: 'application/vnd.in-toto+json',
                  digest: 'sha256:ba223669755123cecd0bc56e1d52fca1436cf70df4b22d34ba5b4ece9f391de7',
                  size: 1938106,
                  annotations: {
                    'in-toto.io/predicate-type': 'https://spdx.dev/Document',
                  },
                },
              ],
            },
            {
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              config: {
                mediaType: 'application/vnd.oci.image.config.v1+json',
                size: 2312,
                digest: 'sha256:5e5a000d140d605ff9f495bddfd11d058cf6c05e8d7273126dcd49125531bd57',
              },
              layers: [
                {
                  mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
                  size: 26851732,
                  digest: 'sha256:4afa85c5883c0db62b02025c149edaaa237af5ba25ea48039e875a802d465ac7',
                },
              ],
            },
            {
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              config: {
                mediaType: 'application/vnd.oci.image.config.v1+json',
                size: 2297,
                digest: 'sha256:97bed23a34971024aa8d254abbe67b7168772340d1f494034773bc464e8dd5b6',
              },
              layers: [
                {
                  mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
                  size: 29723147,
                  digest: 'sha256:4b3ffd8ccb5201a0fc03585952effb4ed2d1ea5e704d2e7330212fb8b16c86a3',
                },
              ],
            },
            {
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              config: {
                mediaType: 'application/vnd.oci.image.config.v1+json',
                digest: 'sha256:d2c6794a73446c2c200bc221c928576fdf5749d32c7065dfb58fa63e9613810f',
                size: 167,
              },
              layers: [
                {
                  mediaType: 'application/vnd.in-toto+json',
                  digest: 'sha256:5f8acbb3bc13c395a998825f929d1be67ccbbc4782d2b8506b822539a77b6372',
                  size: 1940323,
                  annotations: {
                    'in-toto.io/predicate-type': 'https://spdx.dev/Document',
                  },
                },
              ],
            },
            {
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              config: {
                mediaType: 'application/vnd.oci.image.config.v1+json',
                digest: 'sha256:3b3add7a015eddabe1f8fcb39ffae7def926f67474b3bba47cba0137f343e6a7',
                size: 167,
              },
              layers: [
                {
                  mediaType: 'application/vnd.in-toto+json',
                  digest: 'sha256:98cd13f94b85280da21158e1110c44b19a11fb793fd943cb453d8198903f6121',
                  size: 1942531,
                  annotations: {
                    'in-toto.io/predicate-type': 'https://spdx.dev/Document',
                  },
                },
              ],
            },
            {
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              config: {
                mediaType: 'application/vnd.oci.image.config.v1+json',
                size: 2299,
                digest: 'sha256:7bcf37e8ebffb1b727d122f48aed67b0c36c6ec2ea720a6ada3ebfc61b43497e',
              },
              layers: [
                {
                  mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
                  size: 34303525,
                  digest: 'sha256:199e3830c89a37cc6980743d7c9e0e355251d050c55eb838183c9cf64fac375b',
                },
              ],
            },
            {
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              config: {
                mediaType: 'application/vnd.oci.image.config.v1+json',
                digest: 'sha256:6c6c88baf206d4cc59be6f6718e922fb25b986830bc36b0b699e2299020f8f10',
                size: 167,
              },
              layers: [
                {
                  mediaType: 'application/vnd.in-toto+json',
                  digest: 'sha256:f083401df72b3a565a0863d6b77b25bd0b6e64e17e689b530fd1f15055ef0c7b',
                  size: 1939111,
                  annotations: {
                    'in-toto.io/predicate-type': 'https://spdx.dev/Document',
                  },
                },
              ],
            },
            {
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              config: {
                mediaType: 'application/vnd.oci.image.config.v1+json',
                size: 2314,
                digest: 'sha256:e149199029d15548c4f6d2666e88879360381a2be8a1b747412e3fe91fb1d19d',
              },
              layers: [
                {
                  mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
                  size: 28861712,
                  digest: 'sha256:b8a35db46e38ce87d4e743e1265ff436ed36e01d23246b24a1cbbeaae18ec432',
                },
              ],
            },
            {
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              config: {
                mediaType: 'application/vnd.oci.image.config.v1+json',
                digest: 'sha256:ae5abc725ed95926e2a20319ce3534f7cb6f9dc21fd6d295f1ea4549f6564fda',
                size: 167,
              },
              layers: [
                {
                  mediaType: 'application/vnd.in-toto+json',
                  digest: 'sha256:7bae66667b7b05f43acd806d2488878773ca10f1fa2b2e295c67569ef92f900e',
                  size: 1931899,
                  annotations: {
                    'in-toto.io/predicate-type': 'https://spdx.dev/Document',
                  },
                },
              ],
            },
            {
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              config: {
                mediaType: 'application/vnd.oci.image.config.v1+json',
                size: 2299,
                digest: 'sha256:678eefd3f420a76c197da434f174d734b80fffa52cccc288bb4cd763c8765e5a',
              },
              layers: [
                {
                  mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
                  size: 30951381,
                  digest: 'sha256:ff47a256ba51b80e9880bc96be4ac2f094c47e0fcd7eec71bab85787cfa54b8b',
                },
              ],
            },
            {
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              config: {
                mediaType: 'application/vnd.oci.image.config.v1+json',
                size: 2295,
                digest: 'sha256:bec01dfa80e941897d62ca44df1d8b2bde550f5cc4efdfa308170d51e44b1e61',
              },
              layers: [
                {
                  mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
                  size: 29906151,
                  digest: 'sha256:67735b72a65d308a2c2c9505d0d6e8419b7f2654a16cbd56963d88e01202d507',
                },
              ],
            },
            {
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              config: {
                mediaType: 'application/vnd.oci.image.config.v1+json',
                digest: 'sha256:a7de31bf4341df28f1ad4fe295b287c20d823cd474e081bf4e2945eeac8d7f61',
                size: 167,
              },
              layers: [
                {
                  mediaType: 'application/vnd.in-toto+json',
                  digest: 'sha256:e00a0c4a81b2457fe157d12fd1f48ca2b559fe05de7f26993d35247448840b0a',
                  size: 1940953,
                  annotations: {
                    'in-toto.io/predicate-type': 'https://spdx.dev/Document',
                  },
                },
              ],
            },
          ],
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
          collected.images.sort((a, b) => a.config.digest.localeCompare(b.config.digest))
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
