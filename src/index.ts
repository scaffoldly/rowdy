import packageJson from '../package.json';
export const VERSION = packageJson.version;
export const NAME = packageJson.name;

export const id = (): string => {
  return `${NAME}@${VERSION}`;
};

export * as CRI from './cri-api/pkg/apis/runtime/v1/api_pb';
export { fromBinary, toBinary } from '@bufbuild/protobuf';
