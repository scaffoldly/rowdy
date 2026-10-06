import { Logger, Environment, Routes } from '@scaffoldly/rowdy';
import { LocalAdapter, MountAdapter, S3Adapter, VFS_BACKING, VFS_PRELOAD, VFS_SOCKET } from '@scaffoldly/rowdy-vfs';
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
    delete process.env.VFS_MOUNTS;
  });

  // Each Environment may have started a VFS supervisor on the shared socket path.
  afterEach(async () => {
    for (const environment of environments.splice(0)) {
      await environment['_vfs']?.then((server) => server.close());
    }
    rmSync(backing, { recursive: true, force: true });
  });

  it('logs the finalized environment with values masked', async () => {
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    const before = process.env.ROWDY_DEBUG;
    process.env.ROWDY_DEBUG = 'true';
    process.env.CANARY_API_TOKEN = 'canary-0123456789-do-not-log-me-abcdef';
    try {
      const environment = new Environment(logger).withEnv('HTTP_UA', 'canary-user-agent/that-is-long-enough');
      const env = await finalize(environment);
      expect(env.CANARY_API_TOKEN).toBe('canary-0123456789-do-not-log-me-abcdef'); // the child still gets it
      const output = lines.join('\n');
      expect(output).toContain('Environment Variables Finalized');
      expect(output).toContain('CANARY_API_TOKEN');
      expect(output).not.toContain('0123456789-do-not-log-me');
      expect(output).not.toContain('canary-user-agent/that');
    } finally {
      spy.mockRestore();
      delete process.env.CANARY_API_TOKEN;
      if (before === undefined) delete process.env.ROWDY_DEBUG;
      else process.env.ROWDY_DEBUG = before;
    }
  });

  describe('levelOf', () => {
    it('prefers --log-level, then --trace, then --debug, else info', () => {
      expect(Environment.levelOf({})).toBe('info');
      expect(Environment.levelOf({ debug: true })).toBe('debug');
      expect(Environment.levelOf({ debug: true, trace: true })).toBe('trace');
      expect(Environment.levelOf({ logLevel: 'WARN', debug: true, trace: true })).toBe('warn');
      expect(Environment.levelOf({ logLevel: 'chatty', debug: true })).toBe('debug');
    });
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

    it('mounts an s3 volume through the S3Adapter with the default backing directory', async () => {
      const environment = withVolumes(['s3://example-bucket/tenant/42:/data']);
      const env = await finalize(environment);
      expect(env.VFS_PREFIX).toBe('/data');
      expect(env.VFS_BACKING).toBe(VFS_BACKING);
      expect(env.VFS_SOCKET).toBe(VFS_SOCKET);
      const server = await environment['_vfs'];
      expect((server?.['adapter'] as MountAdapter).adapters[0]).toBeInstanceOf(S3Adapter);
    });

    it('passes the lock and local flags through to the adapter', async () => {
      const environment = withVolumes(['s3://example-bucket:/data:lock,local=*-{journal,wal,shm}']);
      await finalize(environment);
      const adapter = ((await environment['_vfs'])?.['adapter'] as MountAdapter).adapters[0] as S3Adapter;
      expect(adapter['options']).toMatchObject({
        bucket: 'example-bucket',
        lockOnOpen: true,
        mountpoint: '/data',
        localOnly: ['*-{journal,wal,shm}'],
      });
    });

    it('mounts every declared volume, each on a backing directory of its own', async () => {
      const environment = withVolumes([
        's3://example-bucket:/s3:local=*-{journal,wal,shm}',
        `file://${backing}:/scratch`,
        's3://other-bucket/tenant:/data',
      ]);
      const env = await finalize(environment);
      expect(env.VFS_MOUNTS).toBe(`/s3=${VFS_BACKING}:/scratch=${backing}:/data=${VFS_BACKING}.2`);
      // the first mount is also the single-mount pair
      expect(env.VFS_PREFIX).toBe('/s3');
      expect(env.VFS_BACKING).toBe(VFS_BACKING);
      const mounts = (await environment['_vfs'])?.['adapter'] as MountAdapter;
      expect(mounts.mountOf('/s3/db/nuss.sqlite')?.adapter).toBeInstanceOf(S3Adapter);
      expect(mounts.mountOf('/scratch/tmp.bin')?.adapter).toBeInstanceOf(LocalAdapter);
      expect((mounts.mountOf('/data/x')?.adapter as S3Adapter)['options']).toMatchObject({
        bucket: 'other-bucket',
        prefix: 'tenant',
        backing: `${VFS_BACKING}.2`,
      });
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
