import { readFileSync } from 'fs';
import { join } from 'path';
import { checkSource, ROWDY_LAYERS, skippedLevel, SourcePlatform } from '../../../src/api/internal/layers';
import { deploySources, layerSources } from '../../../src/api/internal/sources';
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
  `layers-from ${from} (${name}): ${rule}; only its layers go in, so they must match its config and it can't set Env beyond PATH`;

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

  describe('checkSource', () => {
    // Not rowdy's own image, which is exempt: the rules still have to accept its shape.
    const from = 'ghcr.io/example/tool:latest';
    const amd64 = 'linux/amd64';

    it("passes an image built like rowdy's own", () => {
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

    const settingEnv = (f: Fixture): Fixture => {
      f.config.config = { ...f.config.config, Env: ['PATH=/bin', 'FOO=bar'] };
      return f;
    };

    it.each<[string, (f: Fixture) => Fixture]>([
      ['several layers', twoLayers],
      [
        'a RUN layer',
        (f) => {
          f.manifest.layers = [...f.manifest.layers!, { ...f.manifest.layers![0]!, digest: 'sha256:run' }];
          f.config.rootfs!.diff_ids = [...f.config.rootfs!.diff_ids!, 'sha256:run'];
          f.config.history = [...f.config.history!, { created_by: 'RUN /jq --version # buildkit' }];
          return f;
        },
      ],
      [
        'steps that add no layer, like ARG and ENV',
        (f) => {
          f.config.history = [
            { created_by: 'ARG TARGETPLATFORM=linux/amd64', empty_layer: true },
            ...f.config.history!,
            { created_by: 'ENV FOO=bar', empty_layer: true },
          ];
          return f;
        },
      ],
    ])('passes %s', (_, change) => {
      expect(() => checkSource(from, [platform(amd64, change(fixture()))])).not.toThrow();
    });

    it.each<[string, (f: Fixture) => Fixture]>([
      [
        'no layers',
        (f) => {
          f.manifest.layers = [];
          return f;
        },
      ],
      [
        '1 layers but 2 diff_ids',
        (f) => {
          f.config.rootfs!.diff_ids = [...f.config.rootfs!.diff_ids!, 'sha256:extra'];
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
        '1 layers but 2 layer entries in history',
        (f) => {
          f.config.history = [{ created_by: 'COPY /b /b # buildkit' }, ...f.config.history!];
          return f;
        },
      ],
      ['Env sets FOO', settingEnv],
    ])('refuses: %s', (rule, change) => {
      expect(() => checkSource(from, [platform(amd64, change(fixture()))])).toThrow(refusal(from, amd64, rule));
    });

    it("does not limit the layer's size", () => {
      const big = fixture();
      big.manifest.layers![0]!.size = 1024 * 1024 * 1024;
      expect(() => checkSource(from, [platform(amd64, big)])).not.toThrow();
    });

    it("exempts rowdy's own image, which this repo builds", () => {
      expect(() => checkSource(ROWDY_LAYERS, [platform(amd64, settingEnv(fixture()))])).not.toThrow();
    });

    it('checks every platform, not only the one Lambda runs', () => {
      expect(() =>
        checkSource(from, [platform(amd64, fixture()), platform('linux/arm64', settingEnv(fixture()))])
      ).toThrow(refusal(from, 'linux/arm64', 'Env sets FOO'));
    });
  });

  describe('skippedLevel', () => {
    it('warns only for the platform Lambda runs', () => {
      expect(skippedLevel('linux/amd64')).toBe('warn');
      expect(skippedLevel('linux/s390x')).toBe('debug');
      expect(skippedLevel('linux/arm64')).toBe('debug');
    });
  });
});
