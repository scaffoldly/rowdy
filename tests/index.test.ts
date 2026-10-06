import { applyVfs, materialize, shim, shimFile, VFS_PRELOAD, VfsEnv } from '@scaffoldly/rowdy-vfs';
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

    it('ships as a file matching the inlined copy', () => {
      for (const arch of ['x64', 'arm64']) {
        const file = shimFile(arch);
        expect(file).toMatch(new RegExp(`lib/linux-${arch}/vfspreload\\.so$`));
        expect(readFileSync(file!).equals(shim(arch)!)).toBe(true);
      }
      expect(shimFile('mips')).toBeUndefined();
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
      VFS_SOCKET: undefined,
      VFS_MOUNTS: undefined,
      ...overrides,
    });

    describe('mounts', () => {
      const mounts = [
        { prefix: '/s3', backing: '/tmp/vfsstore' },
        { prefix: '/data/cache', backing: '/tmp/vfsstore.1' },
      ];

      it('encodes several mounts for the shim and keeps the first as the single-mount pair', () => {
        const e = env({ ROWDY_VFS: '1' });
        const config = applyVfs(e, { preload, mounts });
        expect(e.VFS_MOUNTS).toBe('/s3=/tmp/vfsstore:/data/cache=/tmp/vfsstore.1');
        expect(e.VFS_PREFIX).toBe('/s3');
        expect(e.VFS_BACKING).toBe('/tmp/vfsstore');
        expect(config).toMatchObject({ prefix: '/s3', backing: '/tmp/vfsstore', mounts });
      });

      it('leaves VFS_MOUNTS unset without the option', () => {
        const e = env({ ROWDY_VFS: '1' });
        expect(applyVfs(e, { preload })).not.toHaveProperty('mounts');
        expect(e.VFS_MOUNTS).toBeUndefined();
      });

      it('rejects prefixes and backing directories the shim could not parse or keep apart', () => {
        const bad =
          (m: Array<{ prefix: string; backing: string }>): (() => unknown) =>
          () =>
            applyVfs(env({ ROWDY_VFS: '1' }), { preload, mounts: m });
        expect(bad([{ prefix: 's3', backing: '/tmp/a' }])).toThrow("invalid mount prefix 's3'");
        expect(bad([{ prefix: '/s3/', backing: '/tmp/a' }])).toThrow('invalid mount prefix');
        expect(bad([{ prefix: '/a:b', backing: '/tmp/a' }])).toThrow('invalid mount prefix');
        expect(bad([{ prefix: '/s3', backing: '/tmp/a=b' }])).toThrow('invalid backing directory');
        expect(
          bad([
            { prefix: '/a', backing: '/tmp/store' },
            { prefix: '/b', backing: '/tmp/store/b' },
          ])
        ).toThrow("backing directory '/tmp/store/b' is inside '/tmp/store'");
      });
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

    it('sets VFS_SOCKET when socket is provided', () => {
      const e = env({ ROWDY_VFS: '1' });
      expect(applyVfs(e, { preload, socket: '/tmp/sock' })).toEqual({
        preload,
        prefix: '/vfs',
        backing: '/tmp/vfsstore',
        socket: '/tmp/sock',
      });
      expect(e.VFS_SOCKET).toBe('/tmp/sock');
    });

    it('does not touch VFS_SOCKET when omitted', () => {
      const e = env({ ROWDY_VFS: '1', VFS_SOCKET: '/tmp/other' });
      expect(applyVfs(e, { preload })).toEqual({
        preload,
        prefix: '/vfs',
        backing: '/tmp/vfsstore',
        socket: '/tmp/other',
      });
      expect(e.VFS_SOCKET).toBe('/tmp/other'); // untouched
    });
  });
});
