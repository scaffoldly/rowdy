import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import {
  GenericContainer,
  getContainerRuntimeClient,
  getReaper,
  LABEL_TESTCONTAINERS_SESSION_ID,
  Wait,
  type Environment,
  type StartedTestContainer,
} from 'testcontainers';
import { exercises, markdown, type Column, type Outcome, type Row } from './summary';

/** The test images; their node is the version `node/test` was copied from (v22.23.3). */
const IMAGES = {
  alpine: 'node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402',
  debian: 'node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392',
} as const;
type Flavour = keyof typeof IMAGES;

const isFlavour = (value: string): value is Flavour => value in IMAGES;
const FLAVOUR = process.env.NODEFS_FLAVOUR ?? 'alpine';
if (!isFlavour(FLAVOUR)) {
  throw new Error(`NODEFS_FLAVOUR must be one of ${Object.keys(IMAGES).join(', ')}, not '${FLAVOUR}'`);
}

const ROOT = join(__dirname, '..', '..', '..');
const NODE = join(__dirname, 'node');
const SHIM = join(ROOT, 'lib', `linux-${process.arch}`, 'vfspreload.so');
const TEST_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 300_000;
const TAIL_LINES = 60;

/** Every vendored test file, as node's runner names it relative to the checkout root. */
const FILES = ['parallel', 'sequential']
  .flatMap((group) =>
    readdirSync(join(NODE, 'test', group))
      .filter((name) => /^test-.*\.m?js$/.test(name))
      .map((name) => `test/${group}/${name}`)
  )
  .sort();

/** node's runner passes a test file's `// Flags:` header lines to node. */
const flagsOf = (rel: string): string[] =>
  readFileSync(join(NODE, rel), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('// Flags:'))
    .flatMap((line) => line.slice('// Flags:'.length).trim().split(/\s+/))
    .filter(Boolean);

const tail = (output: string): string => output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');

/** node's `common.skip()` prints a TAP plan of zero with the reason, and exits 0. */
const skipReason = (stdout: string): string | undefined => /^1\.\.0 # Skipped: (.*)$/m.exec(stdout)?.[1];

/** The variables a process needs to reach AWS, as this process has them. */
const awsEnvironment = (): Environment => {
  const env: Environment = {};
  for (const name of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
  ]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
};

/** A store's container, started: the tests run in `cwd` with their tmpdir under `dir`. */
type Started = { container: StartedTestContainer; cwd: string; dir: string; stop(): Promise<void> };

type Store = Column & { start(): Promise<Started> };

/** The baseline: a docker named volume, no shim. */
const volume: Store = {
  label: 'volume',
  where: 'a docker named volume',
  gate: true,
  async start(): Promise<Started> {
    const client = await getContainerRuntimeClient();
    // Labelled with the session, so the reaper removes it even if stop() never runs.
    const { sessionId } = await getReaper(client);
    const name = `rowdy-nodefs-${randomUUID()}`;
    await client.container.dockerode.createVolume({
      Name: name,
      Labels: { [LABEL_TESTCONTAINERS_SESSION_ID]: sessionId },
    });
    const container = await new GenericContainer(IMAGES[FLAVOUR])
      .withCommand(['sleep', 'infinity'])
      .withBindMounts([
        { source: NODE, target: '/nodefs', mode: 'ro' },
        { source: name, target: '/data', mode: 'rw' },
      ])
      .start();
    // A fresh volume is root's; the tests run as `node`, as an app does, so the permission tests run too.
    expect(await container.exec(['chown', 'node:node', '/data'])).toMatchObject({ exitCode: 0 });
    return {
      container,
      cwd: '/nodefs',
      dir: '/data/nodefs',
      async stop(): Promise<void> {
        await container.stop();
        await client.container.dockerode.getVolume(name).remove();
      },
    };
  },
};

const S3_BUCKET = process.env.NODEFS_S3_BUCKET;
const S3_ENDPOINT = process.env.NODEFS_S3_ENDPOINT;

/**
 * The shim, the package's 9P server and an S3Adapter: the container's environment preloads the shim into
 * every process run in it, and the server (started without it, as rowdy runs it) keeps /vfs in the bucket
 * under a prefix of its own, removed afterwards.
 */
const vfsS3: Store = {
  label: 'vfs+s3',
  where: `/vfs, the shim and the S3 adapter${S3_ENDPOINT ? ` (${S3_ENDPOINT})` : ''}`,
  gate: false,
  skip: process.env.AWS_ACCESS_KEY_ID ? undefined : 'no AWS credentials (AWS_ACCESS_KEY_ID is unset)',
  async start(): Promise<Started> {
    if (!S3_BUCKET) throw new Error('NODEFS_S3_BUCKET is required when AWS credentials are set');
    if (!existsSync(SHIM)) throw new Error(`${SHIM} missing: run native/build.sh ${process.arch} first`);
    if (!existsSync(join(ROOT, 'dist', 'index.js'))) throw new Error('dist/index.js missing: run yarn build first');
    const prefix = `nodefs/${process.env.GITHUB_RUN_ID ?? randomUUID()}-${FLAVOUR}-${process.arch}`;
    const container = await new GenericContainer(IMAGES[FLAVOUR])
      .withUser('node')
      .withBindMounts([{ source: ROOT, target: '/w', mode: 'ro' }])
      .withEnvironment({
        ...awsEnvironment(),
        LD_PRELOAD: `/w/lib/linux-${process.arch}/vfspreload.so`,
        VFS_MOUNTS: '/vfs=/tmp/vfsstore',
        VFS_SOCKET: '/tmp/vfs.sock',
        NODEFS_STORE: 's3',
        NODEFS_S3_BUCKET: S3_BUCKET,
        NODEFS_S3_PREFIX: prefix,
        ...(S3_ENDPOINT ? { NODEFS_S3_ENDPOINT: S3_ENDPOINT } : {}),
      })
      .withCommand([
        'sh',
        '-c',
        'env -u LD_PRELOAD node /w/tests/native/nodefs/server.js > /tmp/server.log 2>&1 & exec sleep infinity',
      ])
      .withWaitStrategy(Wait.forSuccessfulCommand('test -f /tmp/vfs.ready'))
      .withStartupTimeout(60_000)
      .start();
    return {
      container,
      cwd: '/w/tests/native/nodefs/node',
      dir: '/vfs/nodefs',
      async stop(): Promise<void> {
        await container.stop();
        await removePrefix(prefix);
      },
    };
  },
};

/** Every object the run left under `prefix`. */
const removePrefix = async (prefix: string): Promise<void> => {
  const s3 = new S3Client(S3_ENDPOINT ? { endpoint: S3_ENDPOINT, forcePathStyle: true } : {});
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: `${prefix}/`, ContinuationToken: token })
    );
    const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [{ Key: object.Key }] : []));
    if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: S3_BUCKET, Delete: { Objects: keys } }));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
};

const STORES: Store[] = [volume, vfsS3];

/** Each file's outcome in each store, by store label. */
const outcomes = new Map<string, Map<string, Outcome>>(FILES.map((rel) => [rel, new Map()]));
let nodeVersion = '';

afterAll(() => {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const columns: Column[] = STORES.map(({ label, where, gate, skip }) => ({ label, where, gate, skip }));
  const unfinished: Outcome = { status: 'failed', ms: 0, why: 'did not finish', output: '' };
  const rows: Row[] = FILES.map((rel) => {
    const ran = outcomes.get(rel) ?? new Map<string, Outcome>();
    for (const column of columns) if (!column.skip && !ran.has(column.label)) ran.set(column.label, unfinished);
    return { file: basename(rel), exercises: exercises(readFileSync(join(NODE, rel), 'utf8')), outcomes: ran };
  });
  appendFileSync(summary, markdown({ node: nodeVersion, flavour: FLAVOUR, arch: process.arch, columns, rows }));
});

describe.each(STORES)(`node fs/promises tests on $label (${FLAVOUR})`, (store) => {
  if (store.skip) {
    test.skip(`skipped: ${store.skip}`, () => {});
    return;
  }

  let started: Started;

  beforeAll(async () => {
    started = await store.start();
    const { container, dir } = started;
    const probe = await container.exec(
      [
        'node',
        '-e',
        `require('fs').mkdirSync('${dir}', { recursive: true });` +
          `process.stdout.write(require('${started.cwd}/test/common/tmpdir.js').path)`,
      ],
      { user: 'node', env: { NODE_TEST_DIR: dir } }
    );
    // node resolves NODE_TEST_DIR with realpath: it must still name the store, or every test runs elsewhere.
    expect(probe).toMatchObject({ exitCode: 0, stdout: `${dir}/.tmp.0` });
    nodeVersion ||= (await container.exec(['node', '-v'])).stdout.trim();
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    await started?.stop();
  });

  test.each(FILES)(
    '%s',
    async (rel) => {
      const record = (outcome: Outcome): void => {
        outcomes.get(rel)?.set(store.label, outcome);
      };
      const begun = Date.now();
      const result = await started.container.exec(['node', ...flagsOf(rel), rel], {
        user: 'node',
        workingDir: started.cwd,
        env: { NODE_TEST_DIR: started.dir },
      });
      const ms = Date.now() - begun;
      if (result.exitCode === 0) {
        const reason = skipReason(result.stdout);
        record(reason === undefined ? { status: 'passed', ms } : { status: 'skipped', reason });
        return;
      }
      const why = `exit ${result.exitCode}`;
      record({ status: 'failed', ms, why, output: tail(result.output) });
      const message = `${store.label} ${rel}: ${why}\n${tail(result.output)}`;
      if (store.gate) throw new Error(message);
      console.warn(`reported only: ${message}`);
    },
    TEST_TIMEOUT_MS
  );
});
