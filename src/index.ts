import packageJson from '../package.json';
export const VERSION = packageJson.version;
export const NAME = packageJson.name;

export const id = (): string => {
  return `${NAME}@${VERSION}`;
};
