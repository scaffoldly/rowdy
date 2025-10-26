import { id, NAME, VERSION } from '@scaffoldly/rowdy-grpc';
import packageJson from '../package.json';

describe('Library Tests', () => {
  it('should output the correct name', () => {
    expect(NAME).toBe(packageJson.name);
  });

  it('should output the correct version', () => {
    expect(VERSION).toBe(packageJson.version);
  });

  it('should output the correct id', () => {
    expect(id()).toBe(`${packageJson.name}@${packageJson.version}`);
  });
});
