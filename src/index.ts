import packageJson from '../package.json';
const VERSION = packageJson.version;
const NAME = packageJson.name;

const id = (): string => {
  return `${NAME}@${VERSION}`;
};

export { fromBinary, toBinary } from '@bufbuild/protobuf';
export { VERSION, NAME, id };
export { Router } from './router';
export * from './cri';
