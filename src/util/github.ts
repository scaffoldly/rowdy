import { appendFileSync } from 'fs';
import { log } from '../log';

export const writeGithubOutput = (name: string, value?: string): void => {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    return;
  }
  if (!value) {
    log.warn(`GITHUB_OUTPUT is set but there is no value for '${name}', skipping output`);
    return;
  }
  try {
    appendFileSync(output, `${name}=${value}\n`);
  } catch (err) {
    log.warn(`Failed to write '${name}' to GITHUB_OUTPUT`, { error: `${err}` });
  }
};
