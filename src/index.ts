import packageJson from '../package.json';
import { CdkInstrumentation } from './otel';
const VERSION = packageJson.version;
const NAME = packageJson.name;

const id = (): string => {
  return `${NAME}@${VERSION}`;
};

export { VERSION, NAME, id };
export { ClientLogger } from './client';
export { SmithyClientLogger } from './smithy';
export type { ClientLoggerOptions, CommandType } from './client';
export { CloudResource, NotFoundException, FatalException, SkipAction } from './cdk';
export { Logger, isLevel, log, mask, maskEnv, maskHeaders, maskJson, maskQuery, maskUrl } from './log';
export {
  type AttributeInput,
  Attributes,
  poll,
  Redact,
  type Redactor,
  retrying,
  Trace,
  type TracedOptions,
} from './internal/trace';
export type { CdkOptions } from './cdk';
export type { Format, ILoggable, Level, Loggable, Sink } from './log';
export { CdkInstrumentation } from './otel';
export type { CdkInstrumentationOptions } from './otel';

// Hooks in when this package loads, before the libraries it patches; records nothing until a
// tracer provider arrives.
CdkInstrumentation.create();
