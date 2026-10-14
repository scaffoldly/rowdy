import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  GenericContainer,
  getContainerRuntimeClient,
  getReaper,
  LABEL_TESTCONTAINERS_SESSION_ID,
  type ContainerRuntimeClient,
  type StartedTestContainer,
} from 'testcontainers';

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

const NODE = join(__dirname, 'node');
const TESTS = '/nodefs';
const DATA = '/data';
const NODE_TEST_DIR = `${DATA}/nodefs`;
const TEST_TIMEOUT_MS = 120_000;
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

describe(`node fs/promises tests on a docker volume (${FLAVOUR})`, () => {
  let client: ContainerRuntimeClient;
  let container: StartedTestContainer;
  const volume = `rowdy-nodefs-${randomUUID()}`;

  beforeAll(async () => {
    client = await getContainerRuntimeClient();
    // Labelled with the session, so the reaper removes it even if afterAll never runs.
    const { sessionId } = await getReaper(client);
    await client.container.dockerode.createVolume({
      Name: volume,
      Labels: { [LABEL_TESTCONTAINERS_SESSION_ID]: sessionId },
    });
    container = await new GenericContainer(IMAGES[FLAVOUR])
      .withCommand(['sleep', 'infinity'])
      .withBindMounts([
        { source: NODE, target: TESTS, mode: 'ro' },
        { source: volume, target: DATA, mode: 'rw' },
      ])
      .start();
    // A fresh volume is root's; the tests run as `node`, as an app does, so the permission tests run too.
    const chown = await container.exec(['chown', 'node:node', DATA]);
    expect(chown).toMatchObject({ exitCode: 0 });
    const probe = await container.exec(
      [
        'node',
        '-e',
        `require('fs').mkdirSync('${NODE_TEST_DIR}');process.stdout.write(require('${TESTS}/test/common/tmpdir.js').path)`,
      ],
      { user: 'node', env: { NODE_TEST_DIR } }
    );
    expect(probe).toMatchObject({ exitCode: 0, stdout: `${NODE_TEST_DIR}/.tmp.0` });
  }, 300_000);

  afterAll(async () => {
    await container?.stop();
    await client?.container.dockerode.getVolume(volume).remove();
  });

  test.each(FILES)(
    '%s',
    async (rel) => {
      const result = await container.exec(['node', ...flagsOf(rel), rel], {
        user: 'node',
        workingDir: TESTS,
        env: { NODE_TEST_DIR },
      });
      if (result.exitCode !== 0) {
        throw new Error(`${rel} exited ${result.exitCode}\n${tail(result.output)}`);
      }
    },
    TEST_TIMEOUT_MS
  );
});
