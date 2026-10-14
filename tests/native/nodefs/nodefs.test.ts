import { CreateBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import {
  GenericContainer,
  getContainerRuntimeClient,
  getReaper,
  LABEL_TESTCONTAINERS_SESSION_ID,
  Network,
  Wait,
  type Environment,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { exercises, markdown, traffic, type Column, type Outcome, type Row, type Traffic } from './summary';

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
/** A file's run is killed at this, in the container, so the outcome is recorded rather than jest timing out. */
const FILE_TIMEOUT_S = 240;
const TEST_TIMEOUT_MS = (FILE_TIMEOUT_S + 30) * 1000;
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

/** The tests start on an empty store: nothing a test finds was left by an earlier run. */
const expectEmpty = async (container: StartedTestContainer, dir: string): Promise<void> => {
  const listing = await container.exec(['ls', '-A', dir]);
  expect(listing).toMatchObject({ exitCode: 0, stdout: '' });
};

/** Where each store's supervisor log is kept after the run (CI uploads it). */
const LOGS = process.env.NODEFS_LOGS ?? join(ROOT, '.nodefs-logs');

/** The log's size now, so a test's own lines are what follows it. */
const logSize = async (container: StartedTestContainer, log: string): Promise<number> => {
  const size = await container.exec(['stat', '-c', '%s', log]);
  return Number(size.stdout.trim()) || 0;
};

/** The whole log, out of the container before it goes. */
const keepLog = async (container: StartedTestContainer, log: string, label: string): Promise<void> => {
  const { stdout } = await container.exec(['cat', log]);
  mkdirSync(LOGS, { recursive: true });
  writeFileSync(join(LOGS, `${label}-${FLAVOUR}-${process.arch}.jsonl`), stdout);
};

/** A store's container, started: the tests run in `cwd` with their tmpdir under `dir`. */
type Started = {
  container: StartedTestContainer;
  cwd: string;
  dir: string;
  /** The supervisor's JSON lines in the container, when the store has one: counted per test, kept after. */
  log?: string;
  stop(): Promise<void>;
};

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
    await expectEmpty(container, '/data');
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

/** Where the S3 store's objects live, as the server in the store's container and this process reach it. */
type Backend = {
  bucket: string;
  /** The server's environment: credentials, bucket and endpoint. */
  environment: Environment;
  /** This process's client, to check the run's prefix is empty and to clean it up. */
  client: S3Client;
  /** A network the store's container joins to reach the backend, when it is a container too. */
  network?: StartedNetwork;
  stop(): Promise<void>;
};

const AWS = Boolean(process.env.AWS_ACCESS_KEY_ID);

/** AWS (or NODEFS_S3_ENDPOINT's S3-compatible server), with this process's credentials. */
const aws = async (): Promise<Backend> => {
  const bucket = process.env.NODEFS_S3_BUCKET;
  if (!bucket) throw new Error('NODEFS_S3_BUCKET is required when AWS credentials are set');
  const endpoint = process.env.NODEFS_S3_ENDPOINT;
  return {
    bucket,
    environment: {
      ...awsEnvironment(),
      NODEFS_S3_BUCKET: bucket,
      ...(endpoint ? { NODEFS_S3_ENDPOINT: endpoint } : {}),
    },
    client: new S3Client(endpoint ? { endpoint, forcePathStyle: true } : {}),
    async stop(): Promise<void> {},
  };
};

/** MinIO is no longer published to Docker Hub or quay.io; Chainguard builds it (amd64 and arm64). */
const MINIO = 'cgr.dev/chainguard/minio@sha256:2136d593beacf4461187035eca949fe49abd589d5079735025c711ca58fee0c8';

/** A MinIO for this run alone, on a network of its own, with a bucket and credentials made for it. */
const minio = async (): Promise<Backend> => {
  const network = await new Network().start();
  const credentials = { accessKeyId: 'nodefs', secretAccessKey: randomUUID() };
  const server = await new GenericContainer(MINIO)
    .withNetwork(network)
    .withNetworkAliases('minio')
    .withEnvironment({ MINIO_ROOT_USER: credentials.accessKeyId, MINIO_ROOT_PASSWORD: credentials.secretAccessKey })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();
  const client = new S3Client({
    endpoint: `http://${server.getHost()}:${server.getMappedPort(9000)}`,
    forcePathStyle: true,
    region: 'us-east-1',
    credentials,
  });
  const bucket = 'nodefs';
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  return {
    bucket,
    environment: {
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_REGION: 'us-east-1',
      NODEFS_S3_BUCKET: bucket,
      NODEFS_S3_ENDPOINT: 'http://minio:9000',
    },
    client,
    network,
    async stop(): Promise<void> {
      await server.stop();
      await network.stop();
    },
  };
};

/**
 * The shim, the package's 9P server and an S3Adapter: the container's environment preloads the shim into
 * every process run in it, and the server (started without it, as rowdy runs it) keeps /vfs in the bucket
 * under a prefix of its own, removed afterwards. The bucket is AWS's when AWS_ACCESS_KEY_ID is set, else a
 * MinIO started for the run.
 */
const vfsS3: Store = {
  label: AWS ? 'vfs+s3' : 'vfs+minio',
  where: AWS ? '/vfs, the shim and the S3 adapter on S3' : '/vfs, the shim and the S3 adapter on MinIO',
  gate: false,
  async start(): Promise<Started> {
    if (!existsSync(SHIM)) throw new Error(`${SHIM} missing: run native/build.sh ${process.arch} first`);
    if (!existsSync(join(ROOT, 'dist', 'index.js'))) throw new Error('dist/index.js missing: run yarn build first');
    const backend = AWS ? await aws() : await minio();
    // Fresh on every run and every re-run of a CI job; the run id is only there to find it by.
    const prefix = `nodefs/${process.env.GITHUB_RUN_ID ?? 'local'}/${randomUUID()}-${FLAVOUR}-${process.arch}`;
    const existing = await backend.client.send(
      new ListObjectsV2Command({ Bucket: backend.bucket, Prefix: `${prefix}/`, MaxKeys: 1 })
    );
    if (existing.KeyCount) throw new Error(`s3://${backend.bucket}/${prefix}/ is not empty before the run`);
    const image = new GenericContainer(IMAGES[FLAVOUR])
      .withUser('node')
      .withBindMounts([{ source: ROOT, target: '/w', mode: 'ro' }])
      .withEnvironment({
        ...backend.environment,
        LD_PRELOAD: `/w/lib/linux-${process.arch}/vfspreload.so`,
        VFS_MOUNTS: '/vfs=/tmp/vfsstore',
        VFS_SOCKET: '/tmp/vfs.sock',
        NODEFS_STORE: 's3',
        NODEFS_S3_PREFIX: prefix,
      })
      .withCommand([
        'sh',
        '-c',
        'env -u LD_PRELOAD node /w/tests/native/nodefs/server.js > /tmp/server.log 2>&1 & exec sleep infinity',
      ])
      .withWaitStrategy(Wait.forSuccessfulCommand('test -f /tmp/vfs.ready'))
      .withStartupTimeout(60_000);
    const container = await (backend.network ? image.withNetwork(backend.network) : image).start();
    await expectEmpty(container, '/tmp/vfsstore');
    return {
      container,
      cwd: '/w/tests/native/nodefs/node',
      dir: '/vfs/nodefs',
      log: '/tmp/server.log',
      async stop(): Promise<void> {
        await keepLog(container, '/tmp/server.log', vfsS3.label);
        await container.stop();
        await removePrefix(backend, prefix);
        await backend.stop();
      },
    };
  },
};

/** Every object the run left under `prefix`. */
const removePrefix = async ({ client, bucket }: Backend, prefix: string): Promise<void> => {
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/`, ContinuationToken: token })
    );
    const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [{ Key: object.Key }] : []));
    if (keys.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
};

const STORES: Store[] = [volume, vfsS3];

/** Each file's outcome in each store, by store label. */
const outcomes = new Map<string, Map<string, Outcome>>(FILES.map((rel) => [rel, new Map()]));
/** Each file's S3 traffic in each store that has a supervisor log, by store label. */
const traffics = new Map<string, Map<string, Traffic>>(FILES.map((rel) => [rel, new Map()]));
let nodeVersion = '';

afterAll(() => {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const columns: Column[] = STORES.map(({ label, where, gate, skip }) => ({ label, where, gate, skip }));
  const unfinished: Outcome = { status: 'failed', ms: 0, why: 'did not finish', output: '' };
  const rows: Row[] = FILES.map((rel) => {
    const ran = outcomes.get(rel) ?? new Map<string, Outcome>();
    for (const column of columns) if (!column.skip && !ran.has(column.label)) ran.set(column.label, unfinished);
    return {
      file: basename(rel),
      exercises: exercises(readFileSync(join(NODE, rel), 'utf8')),
      outcomes: ran,
      traffic: traffics.get(rel) ?? new Map<string, Traffic>(),
    };
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
      const offset = started.log ? await logSize(started.container, started.log) : 0;
      const begun = Date.now();
      const result = await started.container.exec(['timeout', String(FILE_TIMEOUT_S), 'node', ...flagsOf(rel), rel], {
        user: 'node',
        workingDir: started.cwd,
        env: { NODE_TEST_DIR: started.dir },
      });
      const ms = Date.now() - begun;
      if (started.log) {
        const slice = await started.container.exec(['tail', '-c', `+${offset + 1}`, started.log]);
        traffics.get(rel)?.set(store.label, traffic(slice.stdout));
      }
      if (result.exitCode === 0) {
        const reason = skipReason(result.stdout);
        record(reason === undefined ? { status: 'passed', ms } : { status: 'skipped', reason });
        return;
      }
      // GNU timeout exits 124, busybox's dies by the SIGTERM it sends; either way the clock says so.
      const why = ms >= FILE_TIMEOUT_S * 1000 ? `timed out after ${FILE_TIMEOUT_S}s` : `exit ${result.exitCode}`;
      record({ status: 'failed', ms, why, output: tail(result.output) });
      const message = `${store.label} ${rel}: ${why}\n${tail(result.output)}`;
      if (store.gate) throw new Error(message);
      console.warn(`reported only: ${message}`);
    },
    TEST_TIMEOUT_MS
  );
});
