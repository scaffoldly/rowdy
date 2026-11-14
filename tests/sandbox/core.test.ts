import * as core from '@scaffoldly/rowdy/sandbox/core';
import * as sandbox from '@scaffoldly/rowdy/sandbox';

describe('sandbox/core', () => {
  it("has rowdy's own port in a microVM", () => {
    expect(core.HOOKS_PORT).toBe(32768);
  });

  it('has the default image, timeout and memory', () => {
    expect(core.DEFAULTS).toEqual({ image: 'scaffoldly/sandbox', timeout: 900_000, memory: 512 });
  });

  it('is exported by sandbox too', () => {
    expect(sandbox.HOOKS_PORT).toBe(core.HOOKS_PORT);
    expect(sandbox.DEFAULTS).toBe(core.DEFAULTS);
  });
});
