import { applyVfs, materialize, shim, VFS_PRELOAD, VfsEnv } from '@scaffoldly/rowdy-vfs';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('rowdy-vfs', () => {
  let dir: string;
  let preload: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rowdy-vfs-'));
    preload = join(dir, 'rowdy', 'vfspreload.so');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('shim', () => {
    it('is an ELF object for both architectures', () => {
      for (const arch of ['x64', 'arm64']) {
        const data = shim(arch);
        expect(data).toBeDefined();
        expect(data!.subarray(0, 4).toString('latin1')).toBe('\x7fELF');
      }
    });

    it('is undefined for an unknown architecture', () => {
      expect(shim('mips')).toBeUndefined();
    });
  });

  describe('materialize', () => {
    it('writes the shim as an executable file', () => {
      expect(materialize(preload)).toBe(preload);
      expect(readFileSync(preload).equals(shim()!)).toBe(true);
      expect(statSync(preload).mode & 0o111).toBeTruthy();
    });

    it('is idempotent', () => {
      materialize(preload);
      const { mtimeMs } = statSync(preload);
      materialize(preload);
      expect(statSync(preload).mtimeMs).toBe(mtimeMs);
    });

    it('throws for an unknown architecture', () => {
      expect(() => materialize(preload, 'mips')).toThrow(/no vfspreload shim for linux-mips/);
    });

    it('defaults to the rowdy preload path', () => {
      expect(VFS_PRELOAD).toBe('/tmp/rowdy/vfspreload.so');
    });
  });

  describe('applyVfs', () => {
    const env = (overrides: Partial<VfsEnv> = {}): VfsEnv => ({
      ROWDY_VFS: undefined,
      LD_PRELOAD: undefined,
      VFS_PREFIX: undefined,
      VFS_BACKING: undefined,
      ...overrides,
    });

    it('is off by default', () => {
      const e = env();
      expect(applyVfs(e, preload)).toBeUndefined();
      expect(e.LD_PRELOAD).toBeUndefined();
      expect(existsSync(preload)).toBe(false);
    });

    it('treats an empty ROWDY_VFS as off', () => {
      const e = env({ ROWDY_VFS: '' });
      expect(applyVfs(e, preload)).toBeUndefined();
      expect(e.LD_PRELOAD).toBeUndefined();
    });

    it('enables the preload and defaults the prefix and backing', () => {
      const e = env({ ROWDY_VFS: '1' });
      expect(applyVfs(e, preload)).toEqual({ preload, prefix: '/vfs', backing: '/tmp/vfsstore' });
      expect(e.LD_PRELOAD).toBe(preload);
      expect(e.VFS_PREFIX).toBe('/vfs');
      expect(e.VFS_BACKING).toBe('/tmp/vfsstore');
      expect(existsSync(preload)).toBe(true);
    });

    it('prepends to an existing LD_PRELOAD', () => {
      const e = env({ ROWDY_VFS: '1', LD_PRELOAD: '/opt/other.so' });
      applyVfs(e, preload);
      expect(e.LD_PRELOAD).toBe(`${preload}:/opt/other.so`);
    });

    it('does not double-register the shim', () => {
      const e = env({ ROWDY_VFS: '1', LD_PRELOAD: `${preload}:/opt/other.so` });
      applyVfs(e, preload);
      expect(e.LD_PRELOAD).toBe(`${preload}:/opt/other.so`);
    });

    it('preserves an explicit prefix and backing', () => {
      const e = env({ ROWDY_VFS: 'true', VFS_PREFIX: '/data', VFS_BACKING: '/tmp/data' });
      expect(applyVfs(e, preload)).toEqual({ preload, prefix: '/data', backing: '/tmp/data' });
    });
  });
});
