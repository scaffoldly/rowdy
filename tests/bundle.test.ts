import { buildSync } from 'esbuild';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const EXTERNAL = [
  '@opentelemetry/sdk-node',
  '@opentelemetry/sdk-trace',
  '@opentelemetry/api',
  '@aws-sdk/*',
  '@smithy/*',
];

describe('a host bundle that inlines rxjs, and gives CdkInstrumentation.create() to its SDK', () => {
  // Under node_modules, so the host's external packages resolve from the bundle.
  const cache = join(ROOT, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'rowdy-cdk-bundle-'));
  const outfile = join(dir, 'bundle.mjs');
  let bundle: string;
  type Result = { spans: Array<{ name: string; scope: string; parent?: string; id: string }>; subscriber: string };
  let result: Result;
  const run = (passes: '1' | '0'): Result =>
    JSON.parse(
      execFileSync(process.execPath, [outfile], { encoding: 'utf8', env: { ...process.env, HOST_PASSES: passes } })
    );

  beforeAll(() => {
    buildSync({
      entryPoints: [join(__dirname, 'fixtures', 'bundle-entry.mjs')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: EXTERNAL,
      alias: { '@scaffoldly/rowdy-cdk': join(ROOT, 'dist', 'index.js') },
      // CommonJS inlined into ESM still requires Node's built-ins.
      banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
      logLevel: 'silent',
    });
    bundle = readFileSync(outfile, 'utf8');
    result = run('1');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('inlines rxjs, so no require hook can see it', () => {
    expect(bundle).not.toMatch(/require\(["']rxjs["']\)/);
  });

  it('parents the request made in mergeMap through the inlined rxjs on the span active at subscribe', () => {
    expect(result.spans).toContainEqual(
      expect.objectContaining({ scope: '@opentelemetry/instrumentation-http', parent: result.subscriber })
    );
  });

  it('is off in a host that starts its own SDK without making them', () => {
    expect(run('0').spans.filter((s) => s.scope.startsWith('@opentelemetry/instrumentation-'))).toEqual([]);
  });
});
