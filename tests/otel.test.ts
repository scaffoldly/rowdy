import { execFile } from 'child_process';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

type Seen = {
  spans: { scope: string; name: string; id: string; parent?: string; url?: string }[];
  metrics: string[];
  logs: string[];
  rxjs: boolean;
  /** Each node_modules directory a copy of @smithy/core was bundled from. */
  smithy: string[];
};

const ROOT = join(__dirname, '..');

// A host's own process and bundle: jest's module loader would hide every require from the instrumentations.
const host = async (): Promise<Seen> => {
  const dir = mkdtempSync(join(tmpdir(), 'rowdy-otel-'));
  try {
    const outfile = join(dir, 'host.cjs');
    const { metafile } = await build({
      metafile: true,
      entryPoints: [join(__dirname, 'otel', 'host.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      keepNames: true,
      outfile,
      logLevel: 'silent',
      external: [
        '@opentelemetry/api',
        '@opentelemetry/sdk-node',
        '@opentelemetry/sdk-trace',
        '@opentelemetry/sdk-metrics',
        '@opentelemetry/sdk-logs',
      ],
    });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(AWS_|ROWDY_|HTTPS?_PROXY|NO_PROXY)/i.test(key))
    );
    const { stdout } = await promisify(execFile)(process.execPath, [outfile], {
      cwd: ROOT,
      env: { ...env, NODE_PATH: join(ROOT, 'node_modules') },
      timeout: 90_000,
    });
    const smithy = [
      ...new Set(
        Object.keys(metafile.inputs).flatMap((input) => /^(.*node_modules\/@smithy\/core)\//.exec(input)?.[1] ?? [])
      ),
    ];
    return { ...(JSON.parse(stdout) as Omit<Seen, 'smithy'>), smithy };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('a host with the OpenTelemetry SDK, bundling the sandbox SDK', () => {
  let seen: Seen;
  beforeAll(async () => {
    seen = await host();
  }, 120_000);

  const span = (name: string): Seen['spans'][number] => {
    const found = seen.spans.find((each) => each.name === name);
    if (!found) throw new Error(`No span ${name} in ${seen.spans.map((each) => each.name).join(', ')}`);
    return found;
  };
  // Whether `ancestor` is among `child`'s parents, however far up.
  const under = (child: Seen['spans'][number], ancestor: Seen['spans'][number]): boolean => {
    const parent = seen.spans.find(({ id }) => id === child.parent);
    return !!parent && (parent.id === ancestor.id || under(parent, ancestor));
  };

  it.each([
    ['Lambda.ListFunctions', 'SandboxImpl.list'],
    ['LambdaMicrovms.ListManagedMicrovmImages', 'SandboxImpl.create'],
  ])("traces the AWS SDK's %s, under %s", (call, caller) => {
    const traced = span(call);

    expect(traced.scope).toBe('@opentelemetry/instrumentation-aws-sdk');
    expect(under(traced, span(caller))).toBe(true);
  });

  it('bundles one @smithy/core, so no AWS client goes untraced', () => {
    expect(seen.smithy).toHaveLength(1);
  });

  it("traces axios's requests, under the sandbox call that made them", () => {
    const created = span('SandboxImpl.create');
    const registry = seen.spans.find(
      (each) =>
        each.scope === '@opentelemetry/instrumentation-http' && `${each.url}`.includes('/v2/') && under(each, created)
    );

    expect(registry).toBeDefined();
  });

  it('carries the active span through rxjs', () => {
    expect(seen.rxjs).toBe(true);
  });

  it('records metrics, its own and http’s', () => {
    expect(seen.metrics).toEqual(
      expect.arrayContaining([
        '@scaffoldly/rowdy-cdk cdk.trace.duration',
        '@opentelemetry/instrumentation-http http.client.request.duration',
      ])
    );
  });

  it('logs to the host’s logger provider, its traces and the sandbox’s own lines', () => {
    expect(seen.logs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^@scaffoldly\/rowdy-cdk DEBUG Span Ended/),
        expect.stringMatching(/^@scaffoldly\/rowdy INFO .*Pulling from/),
      ])
    );
  });
});
