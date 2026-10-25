import { readFileSync } from 'fs';
import { join } from 'path';
import {
  checkSource,
  deploySources,
  instructionOf,
  layerSources,
  MAX_LAYER_BYTES,
  ROWDY_LAYERS,
  SourcePlatform,
} from '../../../src/api/internal/layers';
import { External } from '../../../src/api/internal/transfer';
import { specList } from '../../../src/util/list';

type Fixture = { manifest: External['Image']; config: External['Config'] };

const fixture = (): Fixture => JSON.parse(readFileSync(join(__dirname, 'rowdy:beta.source.json'), 'utf-8')) as Fixture;

const platform = (name: string, { manifest, config }: Fixture): SourcePlatform => ({
  platform: name,
  image: manifest,
  config,
});

const refusal = (from: string, name: string, rule: string): string =>
  `layers-from ${from} (${name}): ${rule}; a layers-from image must be one small layer, as rowdy's is (FROM scratch, one COPY, ENTRYPOINT)`;

describe('layers-from', () => {
  describe('specList', () => {
    it('keeps one entry per line, dropping blanks and # lines', () => {
      expect(specList('a\n\n# c\n b \n')).toEqual(['a', 'b']);
    });

    it('takes a YAML list', () => {
      expect(specList('- a\n- b')).toEqual(['a', 'b']);
    });
  });

  describe('sources', () => {
    it('is empty without any', () => {
      expect(layerSources(undefined)).toEqual([]);
    });

    it('flattens flags and lines, keeps the first of a repeat, and drops rowdy', () => {
      expect(layerSources(['x:1', 'y:2\n# no\nx:1', 'ghcr.io/scaffoldly/rowdy:beta'])).toEqual(['x:1', 'y:2']);
    });

    it('takes a YAML list', () => {
      expect(layerSources('- x:1\n- y:2')).toEqual(['x:1', 'y:2']);
    });

    it('puts rowdy last, once', () => {
      expect(deploySources('x:1')).toEqual(['x:1', 'ghcr.io/scaffoldly/rowdy:beta']);
      expect(deploySources(undefined)).toEqual(['ghcr.io/scaffoldly/rowdy:beta']);
      expect(ROWDY_LAYERS).toBe('ghcr.io/scaffoldly/rowdy:beta');
    });
  });

  describe('instructionOf', () => {
    it.each([
      ['COPY /work/bin/rowdy /usr/local/bin/rowdy # buildkit', 'COPY'],
      ['ENTRYPOINT ["/usr/local/bin/rowdy"]', 'ENTRYPOINT'],
      ['/bin/sh -c #(nop)  ENTRYPOINT ["x"]', 'ENTRYPOINT'],
      ['/bin/sh -c #(nop) COPY file:abc in /usr/local/bin/x', 'COPY'],
      ['/bin/sh -c apk add curl', 'RUN'],
      ['RUN /bin/sh -c apk add curl # buildkit', 'RUN'],
    ])('reads %p as %p', (createdBy, instruction) => {
      expect(instructionOf(createdBy)).toBe(instruction);
    });
  });

  describe('checkSource', () => {
    const from = 'ghcr.io/scaffoldly/rowdy:beta';
    const amd64 = 'linux/amd64';

    it("passes rowdy's own image", () => {
      expect(() => checkSource(from, [platform(amd64, fixture())])).not.toThrow();
    });

    const twoLayers = (f: Fixture): Fixture => {
      f.manifest.layers = [...f.manifest.layers!, { ...f.manifest.layers![0]!, digest: 'sha256:second' }];
      f.config.rootfs!.diff_ids = [...f.config.rootfs!.diff_ids!, 'sha256:second'];
      f.config.history = [
        { created_by: 'COPY /a /a # buildkit' },
        { created_by: 'COPY /b /b # buildkit' },
        { created_by: 'ENTRYPOINT ["/a"]', empty_layer: true },
      ];
      return f;
    };

    it.each<[string, (f: Fixture) => Fixture]>([
      ['2 layers', twoLayers],
      [
        `layer is ${MAX_LAYER_BYTES + 1} bytes, over ${MAX_LAYER_BYTES}`,
        (f) => {
          f.manifest.layers![0]!.size = MAX_LAYER_BYTES + 1;
          return f;
        },
      ],
      [
        'RUN in history',
        (f) => {
          f.config.history = [{ created_by: 'RUN /bin/sh -c apk add curl # buildkit' }, ...f.config.history!];
          return f;
        },
      ],
      [
        'ENV in history',
        (f) => {
          f.config.history = [...f.config.history!, { created_by: 'ENV FOO=bar', empty_layer: true }];
          return f;
        },
      ],
      [
        'no history',
        (f) => {
          delete f.config.history;
          return f;
        },
      ],
      [
        '2 layer entries in history',
        (f) => {
          f.config.history = [{ created_by: 'COPY /b /b # buildkit' }, ...f.config.history!];
          return f;
        },
      ],
      [
        'Env sets FOO',
        (f) => {
          f.config.config = { ...f.config.config, Env: ['PATH=/bin', 'FOO=bar'] };
          return f;
        },
      ],
    ])('refuses: %s', (rule, change) => {
      expect(() => checkSource(from, [platform(amd64, change(fixture()))])).toThrow(refusal(from, amd64, rule));
    });

    it('checks every platform, not only the one Lambda runs', () => {
      expect(() =>
        checkSource(from, [platform(amd64, fixture()), platform('linux/arm64', twoLayers(fixture()))])
      ).toThrow(refusal(from, 'linux/arm64', '2 layers'));
    });
  });
});
