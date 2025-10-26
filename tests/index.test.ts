import { id, NAME, VERSION, CRI, fromBinary, toBinary } from '@scaffoldly/rowdy-grpc';
import packageJson from '../package.json';

describe('index', () => {
  it('should output the correct name', () => {
    expect(NAME).toBe(packageJson.name);
  });

  it('should output the correct version', () => {
    expect(VERSION).toBe(packageJson.version);
  });

  it('should output the correct id', () => {
    expect(id()).toBe(`${packageJson.name}@${packageJson.version}`);
  });

  describe('CRI Export', () => {
    it('should export CRI module', () => {
      expect(CRI).toBeDefined();
    });

    it('should serialize and deserialize a sample CRI message', () => {
      const request: CRI.VersionRequest = {
        $typeName: 'runtime.v1.VersionRequest',
        version: '1.0.0',
      };
      expect(fromBinary(CRI.VersionRequestSchema, toBinary(CRI.VersionRequestSchema, request))).toEqual(request);
    });
  });
});
