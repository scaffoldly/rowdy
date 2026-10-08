import { Environment, Logger } from '../src';

describe('entrypoint --volumes', () => {
  const setup = (argv: Record<string, unknown>): Environment => {
    const env = new Environment(new Logger());
    env['setup'](argv);
    return env;
  };

  it('adds the volumes to the routes', () => {
    const env = setup({ volumes: 's3://example-bucket:/data\nfile:///tmp/scratch:/scratch' });

    expect(env.routes.volumes).toEqual(['s3://example-bucket:/data', 'file:///tmp/scratch:/scratch']);
  });

  it('merges the volumes into the routes manifest', () => {
    const env = setup({
      routes: 'volumes:\n  - file:///tmp/scratch:/scratch\n',
      volumes: 's3://example-bucket:/data',
    });

    expect(env.routes.volumes).toEqual(['file:///tmp/scratch:/scratch', 's3://example-bucket:/data']);
  });

  it('skips a volume the routes manifest already declares', () => {
    const env = setup({
      routes: 'volumes:\n  - s3://example-bucket:/data\n',
      volumes: 's3://example-bucket:/data',
    });

    expect(env.routes.volumes).toEqual(['s3://example-bucket:/data']);
  });

  it('fails when a volume takes a mountpoint the routes manifest already uses', () => {
    expect(() =>
      setup({
        routes: 'volumes:\n  - file:///tmp/scratch:/data\n',
        volumes: 's3://example-bucket:/data',
      })
    ).toThrow("Volume mountpoint '/data' is used by both 'file:///tmp/scratch:/data' and 's3://example-bucket:/data'");
  });

  it('keeps the routes manifest when no volumes are given', () => {
    const env = setup({ routes: 'volumes:\n  - file:///tmp/scratch:/scratch\n' });

    expect(env.routes.volumes).toEqual(['file:///tmp/scratch:/scratch']);
  });
});
