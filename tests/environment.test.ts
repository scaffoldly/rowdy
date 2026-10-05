import { Logger, Environment, Routes } from '@scaffoldly/rowdy';
import { VFS_PRELOAD, VFS_SOCKET } from '@scaffoldly/rowdy-vfs';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { lastValueFrom, ReplaySubject } from 'rxjs';

describe('environment', () => {
  const logger = new Logger();
  const environments: Environment[] = [];
  let backing: string;

  // Env emits once the internal variable stream completes (normally after the
  // routes manifest is processed); complete it directly here.
  const finalize = async (environment: Environment): Promise<Record<string, string | undefined>> => {
    environments.push(environment);
    const env = lastValueFrom(environment.Env);
    environment['_envVars'].complete();
    return env;
  };

  // Declaring `volumes:` in the Routes manifest is the opt-in for the VFS.
  const withVolumes = (specs: string[], environment = new Environment(logger)): Environment => {
    environment['_routes'] = Routes.fromSchema({ volumes: specs });
    return environment;
  };

  beforeEach(() => {
    backing = mkdtempSync(join(tmpdir(), 'rowdy-vfs-'));
    delete process.env.ROWDY_VFS;
    delete process.env.LD_PRELOAD;
    delete process.env.VFS_PREFIX;
    delete process.env.VFS_BACKING;
    delete process.env.VFS_SOCKET;
  });

  // Each Environment may have started a VFS supervisor on the shared socket path.
  afterEach(async () => {
    for (const environment of environments.splice(0)) {
      await environment['_vfs']?.then((server) => server.close());
    }
    rmSync(backing, { recursive: true, force: true });
  });

  describe('userspace VFS', () => {
    it('is off without volumes', async () => {
      const environment = new Environment(logger);
      const env = await finalize(environment);
      expect(env.ROWDY_VFS).toBeUndefined();
      expect(env.LD_PRELOAD).toBeUndefined();
      expect(env.VFS_PREFIX).toBeUndefined();
      expect(env.VFS_BACKING).toBeUndefined();
      expect(env.VFS_SOCKET).toBeUndefined();
      expect(environment['_vfs']).toBeUndefined();
    });

    it('ignores ROWDY_VFS in the process environment: volumes are the switch', async () => {
      process.env.ROWDY_VFS = '1';
      const environment = new Environment(logger);
      const env = await finalize(environment);
      expect(env.LD_PRELOAD).toBeUndefined();
      expect(environment['_vfs']).toBeUndefined();
    });

    it('mounts a file volume: preload, prefix, backing, supervisor socket', async () => {
      const environment = withVolumes([`file://${backing}:/vfs`]);
      const env = await finalize(environment);
      expect(env.ROWDY_VFS).toBe('1');
      expect(env.LD_PRELOAD).toBe(VFS_PRELOAD);
      expect(env.VFS_PREFIX).toBe('/vfs');
      expect(env.VFS_BACKING).toBe(backing);
      expect(env.VFS_SOCKET).toBe(VFS_SOCKET);
      expect(existsSync(VFS_PRELOAD)).toBe(true);
      expect(existsSync(VFS_SOCKET)).toBe(true);
      const server = await environment['_vfs'];
      expect(server?.listening).toBe(true);
    });

    it('uses the declared mountpoint as the prefix', async () => {
      const env = await finalize(withVolumes([`file://${backing}:/data`]));
      expect(env.VFS_PREFIX).toBe('/data');
    });

    it('rejects an s3 volume until the adapter exists', async () => {
      await expect(finalize(withVolumes(['s3://example-bucket:/vfs']))).rejects.toThrow('s3:// is not supported yet');
    });

    it('mounts only the first volume for now', async () => {
      const env = await finalize(withVolumes([`file://${backing}:/first`, `file://${backing}:/second`]));
      expect(env.VFS_PREFIX).toBe('/first');
    });

    it('starts the supervisor once per environment', async () => {
      const environment = withVolumes([`file://${backing}:/vfs`]);
      await finalize(environment);
      const first = environment['_vfs'];
      environment['_envVars'] = new ReplaySubject();
      await finalize(environment);
      expect(environment['_vfs']).toBe(first);
    });

    it('prepends to an existing LD_PRELOAD', async () => {
      process.env.LD_PRELOAD = '/opt/other.so';
      const env = await finalize(withVolumes([`file://${backing}:/vfs`]));
      expect(env.LD_PRELOAD).toBe(`${VFS_PRELOAD}:/opt/other.so`);
    });

    it('does not mutate the rowdy process environment', async () => {
      await finalize(withVolumes([`file://${backing}:/vfs`]));
      expect(process.env.ROWDY_VFS).toBeUndefined();
      expect(process.env.LD_PRELOAD).toBeUndefined();
      expect(process.env.VFS_SOCKET).toBeUndefined();
    });
  });
});
