import { mkdtempSync, readdirSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Environment, Logger } from '../src';

// `rowdy secrets <dir>`, as a GitHub Action runs it before a docker build, for BuildKit's secret files.
describe('rowdy secrets', () => {
  const run = (secrets: string): string => {
    const dir = join(mkdtempSync(join(tmpdir(), 'rowdy-secrets-')), 'out');
    new Environment(new Logger(), { argv: ['secrets', dir, '--secrets', secrets] });
    return dir;
  };

  it('writes each secret to a file named for it, from lines and JSON objects', () => {
    const dir = run('SENTRY_AUTH_TOKEN=sntrys_abc\n{"github_token":"ghs_x","NUMBER":42}');

    expect(readdirSync(dir).sort()).toEqual(['NUMBER', 'SENTRY_AUTH_TOKEN', 'github_token']);
    expect(readFileSync(join(dir, 'SENTRY_AUTH_TOKEN'), 'utf8')).toBe('sntrys_abc');
    expect(readFileSync(join(dir, 'NUMBER'), 'utf8')).toBe('42');
  });

  it('lets a line win over a JSON object, as a deploy does', () => {
    const dir = run('{"TOKEN":"from-json"}\nTOKEN=from-line');

    expect(readFileSync(join(dir, 'TOKEN'), 'utf8')).toBe('from-line');
  });

  it('keeps a value with newlines whole', () => {
    const dir = run(JSON.stringify({ KEY: '-----BEGIN KEY-----\nabc\n-----END KEY-----' }));

    expect(readFileSync(join(dir, 'KEY'), 'utf8')).toBe('-----BEGIN KEY-----\nabc\n-----END KEY-----');
  });

  it('lets only its owner read them', () => {
    const dir = run('TOKEN=x');

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'TOKEN')).mode & 0o777).toBe(0o600);
  });

  it("writes no file for a name that isn't one, so no key makes a path", () => {
    const dir = run(JSON.stringify({ '../escape': 'x', 'a/b': 'y', OK: 'z' }));

    expect(readdirSync(dir)).toEqual(['OK']);
    expect(readdirSync(join(dir, '..'))).toEqual(['out']);
  });

  it('writes nothing for an empty one', () => {
    const dir = run('EMPTY=\nSET=1');

    expect(readdirSync(dir)).toEqual(['SET']);
  });
});
