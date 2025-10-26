import { id } from '@scaffoldly/rowdy-grpc';
import packageJson from '../package.json';

describe('Library Tests', () => {
  it('should output the correct id', () => {
    expect(id()).toBe(`${packageJson.name}@${packageJson.version}`);
  });
});
