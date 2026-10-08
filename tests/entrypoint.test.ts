import { Environment, Logger } from '../src';

describe('entrypoint -v', () => {
  const setup = (argv: Record<string, unknown>): Environment => {
    const env = new Environment(new Logger());
    env['setup'](argv);
    return env;
  };

  const parse = (args: string[]): Environment => {
    const argv = process.argv;
    process.argv = ['node', 'rowdy', ...args];
    try {
      return new Environment(new Logger());
    } finally {
      process.argv = argv;
    }
  };

  it('takes one volume per -v, like docker run', () => {
    const env = setup({ volume: ['s3://example-bucket:/data', 'file:///tmp/scratch:/scratch'] });

    expect(env.routes.volumes).toEqual(['s3://example-bucket:/data', 'file:///tmp/scratch:/scratch']);
  });

  it('takes a single -v', () => {
    const env = setup({ volume: 's3://example-bucket:/data' });

    expect(env.routes.volumes).toEqual(['s3://example-bucket:/data']);
  });

  it('reads a bare host path as file://, like docker run', () => {
    const env = setup({ volume: ['/tmp/scratch:/scratch'] });

    expect(env.routes.volumes).toEqual(['file:///tmp/scratch:/scratch']);
  });

  it('merges the volumes into the routes manifest', () => {
    const env = setup({
      routes: 'volumes:\n  - file:///tmp/scratch:/scratch\n',
      volume: ['s3://example-bucket:/data'],
    });

    expect(env.routes.volumes).toEqual(['file:///tmp/scratch:/scratch', 's3://example-bucket:/data']);
  });

  it('skips a volume the routes manifest already declares', () => {
    const env = setup({
      routes: 'volumes:\n  - s3://example-bucket:/data\n',
      volume: ['s3://example-bucket:/data'],
    });

    expect(env.routes.volumes).toEqual(['s3://example-bucket:/data']);
  });

  it('fails when a volume takes a mountpoint the routes manifest already uses', () => {
    expect(() =>
      setup({
        routes: 'volumes:\n  - file:///tmp/scratch:/data\n',
        volume: ['s3://example-bucket:/data'],
      })
    ).toThrow("Volume mountpoint '/data' is used by both 'file:///tmp/scratch:/data' and 's3://example-bucket:/data'");
  });

  it('rejects a docker named volume', () => {
    expect(() => setup({ volume: ['data:/data'] })).toThrow('data:/data');
  });

  it('keeps the routes manifest when no volumes are given', () => {
    const env = setup({ routes: 'volumes:\n  - file:///tmp/scratch:/scratch\n' });

    expect(env.routes.volumes).toEqual(['file:///tmp/scratch:/scratch']);
  });

  it('parses repeated -v from the command line', () => {
    const env = parse(['-v', '/tmp/scratch:/scratch', '--volume', 's3://example-bucket:/data', '--', 'true']);

    expect(env.routes.volumes).toEqual(['file:///tmp/scratch:/scratch', 's3://example-bucket:/data']);
    expect(env.command).toEqual(['true']);
  });

  it('does not take the next argument after a -v value', () => {
    const env = parse(['-v', '/tmp/scratch:/scratch', 'serve', '--', 'true']);

    expect(env.routes.volumes).toEqual(['file:///tmp/scratch:/scratch']);
    expect(env.command).toEqual(['true']);
  });
});
