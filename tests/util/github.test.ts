import { deployFailedSummary, deploySummary, writeGithubOutput, writeGithubSummary } from '../../src/util/github';
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

describe('deploySummary', () => {
  it('renders the deployed function as a table', () => {
    expect(
      deploySummary({
        url: 'https://abc123.lambda-url.us-east-1.on.aws/',
        image: 'ghcr.io/owner/repo:rowdy@sha256:0123',
        functionArn: 'arn:aws:lambda:us-east-1:123456789012:function:owner-repo:rowdy',
        alias: 'rowdy',
        memory: 512,
        volumes: ['s3://example-bucket/data:/data'],
      })
    ).toBe(
      [
        '### 🚀 Deployed `owner-repo`',
        '',
        '| | |',
        '|---|---|',
        '| URL | https://abc123.lambda-url.us-east-1.on.aws/ |',
        '| Image | `ghcr.io/owner/repo:rowdy@sha256:0123` |',
        '| Cloud | aws / lambda (us-east-1) |',
        '| Alias | `rowdy` |',
        '| Memory | 512 MB |',
        '| Volumes | `s3://example-bucket/data:/data` |',
        '',
      ].join('\n')
    );
  });

  it('leaves out rows it has no value for', () => {
    expect(
      deploySummary({
        url: 'https://abc123.lambda-url.us-east-1.on.aws/',
        image: 'nginx:latest',
        functionArn: 'arn:aws:lambda:eu-west-1:123456789012:function:owner-repo',
        volumes: [],
      })
    ).toBe(
      [
        '### 🚀 Deployed `owner-repo`',
        '',
        '| | |',
        '|---|---|',
        '| URL | https://abc123.lambda-url.us-east-1.on.aws/ |',
        '| Image | `nginx:latest` |',
        '| Cloud | aws / lambda (eu-west-1) |',
        '',
      ].join('\n')
    );
  });

  it('lists each volume in its own code span', () => {
    expect(
      deploySummary({
        image: 'nginx:latest',
        volumes: ['s3://example-bucket/a:/a', 's3://example-bucket/b:/b:ro'],
      })
    ).toBe(
      [
        '### 🚀 Deployed',
        '',
        '| | |',
        '|---|---|',
        '| Image | `nginx:latest` |',
        '| Cloud | aws / lambda |',
        '| Volumes | `s3://example-bucket/a:/a`<br>`s3://example-bucket/b:/b:ro` |',
        '',
      ].join('\n')
    );
  });
});

describe('deployFailedSummary', () => {
  it('renders the image and the error', () => {
    expect(deployFailedSummary('nginx:latest', new Error('Function owner-repo failed: InvalidImage'))).toBe(
      [
        '### ❌ Deploy failed',
        '',
        'Image: `nginx:latest`',
        '',
        '```',
        'Function owner-repo failed: InvalidImage',
        '```',
        '',
      ].join('\n')
    );
  });
});

describe('writeGithubSummary', () => {
  const OLD_GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY;
  let summaryFile: string;

  beforeEach(() => {
    summaryFile = join(mkdtempSync(join(tmpdir(), 'rowdy-test-')), 'step_summary');
    writeFileSync(summaryFile, '');
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
  });

  afterEach(() => {
    if (OLD_GITHUB_STEP_SUMMARY === undefined) {
      delete process.env.GITHUB_STEP_SUMMARY;
    } else {
      process.env.GITHUB_STEP_SUMMARY = OLD_GITHUB_STEP_SUMMARY;
    }
  });

  it('appends the markdown to the GITHUB_STEP_SUMMARY file', () => {
    writeFileSync(summaryFile, '## Earlier step\n');
    writeGithubSummary('### 🚀 Deployed\n');
    expect(readFileSync(summaryFile, 'utf8')).toBe('## Earlier step\n### 🚀 Deployed\n');
  });

  it('does nothing when GITHUB_STEP_SUMMARY is unset', () => {
    delete process.env.GITHUB_STEP_SUMMARY;
    expect(() => writeGithubSummary('### 🚀 Deployed\n')).not.toThrow();
    expect(readFileSync(summaryFile, 'utf8')).toBe('');
  });

  it('does not throw when the GITHUB_STEP_SUMMARY file is unwritable', () => {
    process.env.GITHUB_STEP_SUMMARY = join(tmpdir(), 'rowdy-test-nonexistent-dir', 'nested', 'step_summary');
    expect(() => writeGithubSummary('### 🚀 Deployed\n')).not.toThrow();
  });
});
