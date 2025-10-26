import { id, NAME, VERSION, CRI, fromBinary, toBinary, Router } from '@scaffoldly/rowdy-grpc';
import packageJson from '../package.json';

describe('exports', () => {
  it('should output the correct name', () => {
    expect(NAME).toBe(packageJson.name);
  });

  it('should output the correct version', () => {
    expect(VERSION).toBe(packageJson.version);
  });

  it('should output the correct id', () => {
    expect(id()).toBe(`${packageJson.name}@${packageJson.version}`);
  });

  it('should export CRI module', () => {
    expect(CRI).toBeDefined();
  });

  it('should export Router module', () => {
    expect(Router).toBeDefined();
  });

  it('should provide fromBinary and toBinary', () => {
    const request: CRI.VersionRequest = {
      $typeName: 'runtime.v1.VersionRequest',
      version: '1.0.0',
    };
    expect(fromBinary(CRI.VersionRequestSchema, toBinary(CRI.VersionRequestSchema, request))).toEqual(request);
  });
});
