import { appendFileSync } from 'fs';
import { log as root } from '../log';

const log = root.child('github');

export const writeGithubOutput = (name: string, value?: string): void => {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    return;
  }
  if (!value) {
    log.warn('GitHub Output Skipped', { name, reason: 'no value' });
    return;
  }
  try {
    appendFileSync(output, `${name}=${value}\n`);
  } catch (err) {
    log.warn('GitHub Output Failed', { name, error: `${err}` });
  }
};

export const writeGithubSummary = (markdown: string): void => {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) {
    return;
  }
  try {
    appendFileSync(summary, markdown);
  } catch (err) {
    log.warn('GitHub Summary Failed', { error: `${err}` });
  }
};

export type DeploySummary = {
  url?: string;
  image: string;
  functionArn?: string;
  alias?: string;
  memory?: number;
  volumes?: string[];
};

const code = (value: string): string => `\`${value}\``;

export const deploySummary = ({ url, image, functionArn, alias, memory, volumes = [] }: DeploySummary): string => {
  // arn:aws:lambda:<region>:<account>:function:<name>[:<qualifier>]
  const [, , , region, , , name] = functionArn?.split(':') ?? [];
  const rows: Array<[string, string | undefined]> = [
    ['URL', url],
    ['Image', code(image)],
    ['Cloud', region ? `aws / lambda (${region})` : 'aws / lambda'],
    ['Alias', alias && code(alias)],
    ['Memory', memory ? `${memory} MB` : undefined],
    ['Volumes', volumes.length ? volumes.map(code).join('<br>') : undefined],
  ];
  return [
    name ? `### 🚀 Deployed ${code(name)}` : '### 🚀 Deployed',
    '',
    '| | |',
    '|---|---|',
    ...rows.filter(([, value]) => value).map(([key, value]) => `| ${key} | ${value} |`),
    '',
  ].join('\n');
};

export const deployFailedSummary = (image: string, error: Error): string =>
  ['### ❌ Deploy failed', '', `Image: ${code(image)}`, '', '```', error.message, '```', ''].join('\n');
