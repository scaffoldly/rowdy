// Runs node's own fs/promises tests (native/nodefs/node, vendored verbatim) one file at a time, with
// the tests' tmpdir under NODE_TEST_DIR. TAP on stdout; the exit status is the number of failed files,
// capped at 125.
//
//   node run.js --dir <NODE_TEST_DIR> [--filter <regex>]
/* global require, process, __dirname, console */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'node');
const TIMEOUT_MS = 120_000;
const TAIL_LINES = 40;

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = option('--dir');
const filter = option('--filter') ? new RegExp(option('--filter')) : undefined;
if (!dir) {
  console.error('usage: node run.js --dir <NODE_TEST_DIR> [--filter <regex>]');
  process.exit(2);
}

process.env.NODE_TEST_DIR = dir;
const env = { ...process.env };

const tests = ['parallel', 'sequential']
  .flatMap((group) =>
    fs
      .readdirSync(path.join(ROOT, 'test', group))
      .filter((name) => /^test-.*\.m?js$/.test(name))
      .map((name) => path.join('test', group, name))
  )
  .filter((rel) => !filter || filter.test(rel))
  .sort();

/** node's test runner reads `// Flags:` lines from the file's header. */
const flagsOf = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('// Flags:'))
    .flatMap((line) => line.slice('// Flags:'.length).trim().split(/\s+/))
    .filter(Boolean);

const tail = (text) => text.trimEnd().split('\n').slice(-TAIL_LINES);

fs.mkdirSync(dir, { recursive: true });
// The tests resolve NODE_TEST_DIR with realpath: it must still name the same directory, or they would
// all run somewhere else.
const tmpPath = require(path.join(ROOT, 'test', 'common', 'tmpdir.js')).path;
if (!tmpPath.startsWith(`${fs.realpathSync(dir)}/`)) {
  console.error(`tmpdir resolves to '${tmpPath}', not under ${dir}`);
  process.exit(2);
}

console.log(`# tmpdir ${tmpPath}`);
console.log(`1..${tests.length}`);
let failed = 0;
tests.forEach((rel, i) => {
  const file = path.join(ROOT, rel);
  const started = Date.now();
  const out = spawnSync(process.execPath, [...flagsOf(file), file], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const skipped = out.status === 0 && /^1\.\.0 # Skipped: (.*)$/m.exec(out.stdout);
  if (skipped) {
    console.log(`ok ${i + 1} ${rel} # SKIP ${skipped[1]}`);
  } else if (out.status === 0) {
    console.log(`ok ${i + 1} ${rel} # ${ms} ms`);
  } else {
    failed++;
    const why = out.error ? out.error.message : out.signal ? `killed by ${out.signal}` : `exit ${out.status}`;
    console.log(`not ok ${i + 1} ${rel} # ${why}, ${ms} ms`);
    for (const line of tail(`${out.stdout}\n${out.stderr}`)) console.log(`#   ${line}`);
  }
});
console.log(`# ${tests.length - failed}/${tests.length} passed`);
process.exit(Math.min(failed, 125));
