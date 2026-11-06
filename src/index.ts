import packageJson from '../package.json';
const VERSION = packageJson.version;
const NAME = packageJson.name;

const id = (): string => {
  return `${NAME}@${VERSION}`;
};

export { VERSION, NAME, id };
export { CloudResource, NotFoundException, FatalException, SkipAction } from './cdk';
export { Logger, Trace, isLevel, log, mask, maskEnv, maskHeaders, maskJson, maskQuery, maskUrl } from './log';
export type { Format, ILoggable, Level, Loggable } from './log';
