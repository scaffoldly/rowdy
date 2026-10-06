// Exercises the bundled artifact (dist/index.js), not the TypeScript source: the
// esbuild binary loader's output must run on the oldest supported Node.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('dist/index.js', () => {
  const dist = require('../dist') as typeof import('../src');

  it('decodes the inlined shims', () => {
    for (const arch of ['x64', 'arm64']) {
      const data = dist.shim(arch);
      expect(data!.subarray(0, 4).toString('latin1')).toBe('\x7fELF');
    }
  });

  it('materializes a shim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rowdy-vfs-dist-'));
    try {
      const path = dist.materialize(join(dir, 'vfspreload.so'));
      expect(dist.applyVfs({ ROWDY_VFS: '1' } as never, path)).toEqual({
        preload: path,
        prefix: '/vfs',
        backing: '/tmp/vfsstore',
        mounts: [{ prefix: '/vfs', backing: '/tmp/vfsstore' }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
