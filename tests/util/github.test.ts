import { writeGithubOutput } from '../../src/util/github';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('writeGithubOutput', () => {
  const OLD_GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;
  let outputFile: string;

  beforeEach(() => {
    outputFile = join(mkdtempSync(join(tmpdir(), 'rowdy-test-')), 'github_output');
    writeFileSync(outputFile, '');
    process.env.GITHUB_OUTPUT = outputFile;
  });

  afterEach(() => {
    if (OLD_GITHUB_OUTPUT === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = OLD_GITHUB_OUTPUT;
    }
  });

  it('appends name=value to the GITHUB_OUTPUT file', () => {
    writeGithubOutput('url', 'https://example.lambda-url.us-east-1.on.aws/');
    expect(readFileSync(outputFile, 'utf8')).toBe('url=https://example.lambda-url.us-east-1.on.aws/\n');
  });

  it('preserves existing content in the GITHUB_OUTPUT file', () => {
    writeFileSync(outputFile, 'existing=value\n');
    writeGithubOutput('url', 'https://example.com/');
    expect(readFileSync(outputFile, 'utf8')).toBe('existing=value\nurl=https://example.com/\n');
  });

  it('does nothing when GITHUB_OUTPUT is unset', () => {
    delete process.env.GITHUB_OUTPUT;
    expect(() => writeGithubOutput('url', 'https://example.com/')).not.toThrow();
    expect(readFileSync(outputFile, 'utf8')).toBe('');
  });

  it('does nothing when the value is undefined', () => {
    writeGithubOutput('url', undefined);
    expect(readFileSync(outputFile, 'utf8')).toBe('');
  });

  it('does not throw when the GITHUB_OUTPUT file is unwritable', () => {
    process.env.GITHUB_OUTPUT = join(tmpdir(), 'rowdy-test-nonexistent-dir', 'nested', 'github_output');
    expect(() => writeGithubOutput('url', 'https://example.com/')).not.toThrow();
  });
});
