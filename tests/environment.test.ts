import { Logger, Environment } from '@scaffoldly/rowdy';
import { lastValueFrom } from 'rxjs';

describe('environment', () => {
  const logger = new Logger();

  // Env emits once the internal variable stream completes (normally after the
  // routes manifest is processed); complete it directly here.
  const finalize = async (environment: Environment): Promise<Record<string, string | undefined>> => {
    const env = lastValueFrom(environment.Env);
    environment['_envVars'].complete();
    return env;
  };

  describe('userspace VFS preload', () => {
    const PRELOAD = '/usr/local/lib/rowdy/vfspreload.so';

    beforeEach(() => {
      delete process.env.ROWDY_VFS;
      delete process.env.LD_PRELOAD;
      delete process.env.VFS_PREFIX;
      delete process.env.VFS_BACKING;
    });

    it('is off by default', async () => {
      const env = await finalize(new Environment(logger));
      expect(env.LD_PRELOAD).toBeUndefined();
      expect(env.VFS_PREFIX).toBeUndefined();
      expect(env.VFS_BACKING).toBeUndefined();
    });

    it('is enabled by ROWDY_VFS in the process environment', async () => {
      process.env.ROWDY_VFS = '1';
      const env = await finalize(new Environment(logger));
      expect(env.LD_PRELOAD).toBe(PRELOAD);
      expect(env.VFS_PREFIX).toBe('/vfs');
      expect(env.VFS_BACKING).toBe('/tmp/vfsstore');
    });

    it('is enabled by ROWDY_VFS via withEnv', async () => {
      const env = await finalize(new Environment(logger).withEnv('ROWDY_VFS', 'true'));
      expect(env.LD_PRELOAD).toBe(PRELOAD);
    });

    it('treats an empty ROWDY_VFS as off', async () => {
      process.env.ROWDY_VFS = '';
      const env = await finalize(new Environment(logger));
      expect(env.LD_PRELOAD).toBeUndefined();
    });

    it('prepends to an existing LD_PRELOAD', async () => {
      process.env.ROWDY_VFS = '1';
      process.env.LD_PRELOAD = '/opt/other.so';
      const env = await finalize(new Environment(logger));
      expect(env.LD_PRELOAD).toBe(`${PRELOAD}:/opt/other.so`);
    });

    it('does not double-register the shim', async () => {
      process.env.ROWDY_VFS = '1';
      process.env.LD_PRELOAD = `${PRELOAD}:/opt/other.so`;
      const env = await finalize(new Environment(logger));
      expect(env.LD_PRELOAD).toBe(`${PRELOAD}:/opt/other.so`);
    });

    it('preserves explicit VFS_PREFIX and VFS_BACKING', async () => {
      process.env.ROWDY_VFS = '1';
      const env = await finalize(
        new Environment(logger).withEnv('VFS_PREFIX', '/data').withEnv('VFS_BACKING', '/tmp/data')
      );
      expect(env.VFS_PREFIX).toBe('/data');
      expect(env.VFS_BACKING).toBe('/tmp/data');
    });

    it('does not mutate the rowdy process environment', async () => {
      process.env.ROWDY_VFS = '1';
      await finalize(new Environment(logger));
      expect(process.env.LD_PRELOAD).toBeUndefined();
    });
  });
});
