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
