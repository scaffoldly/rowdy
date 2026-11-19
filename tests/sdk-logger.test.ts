import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { join } from 'path';

// What the SDK can reach, as a host bundling it would.
const graph = async (entry: string): Promise<string[]> => {
  const { metafile } = await build({
    entryPoints: [join(__dirname, '..', entry)],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    packages: 'external',
    logLevel: 'silent',
  });
  return Object.keys(metafile.inputs).filter((file) => file.startsWith('src/'));
};

describe("the SDK's logging", () => {
  it.each(['src/sandbox/index.ts', 'src/sandbox/core.ts'])(
    '%s never reaches the process-wide logger, so a sandbox logs only where its host asked',
    async (entry) => {
      const files = await graph(entry);

      expect(files.length).toBeGreaterThan(0);
      expect(files).not.toContain('src/runtime-log.ts');
      const shared = files.filter((file) =>
        /\bimport\s*\{[^}]*\blog\b[^}]*\}\s*from\s*'@scaffoldly\/rowdy-cdk'|@Trace\(\)/.test(
          readFileSync(join(__dirname, '..', file), 'utf8')
        )
      );
      expect(shared).toEqual([]);
    },
    60_000
  );

  it("doesn't export the process-wide logger from rowdy's own log module", async () => {
    const log = await import('../src/log');

    expect('log' in log).toBe(false);
  });
});
