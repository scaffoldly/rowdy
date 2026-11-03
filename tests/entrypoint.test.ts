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

  it('takes one volume per -v, like docker run', () => {
    const env = setup({ volume: ['s3://example-bucket:/data', 'file:///tmp/scratch:/scratch'] });

    expect(env.routes.volumes).toEqual(['s3://example-bucket:/data', 'file:///tmp/scratch:/scratch']);
  });

  it('reads a bare host path in -v as file://, like docker run', () => {
    const env = setup({ volume: ['/tmp/scratch:/scratch'] });

    expect(env.routes.volumes).toEqual(['file:///tmp/scratch:/scratch']);
  });

  it('adds -v after --volumes and the routes manifest', () => {
    const env = setup({
      routes: 'volumes:\n  - file:///tmp/scratch:/scratch\n',
      volumes: 's3://example-bucket:/data',
      volume: ['/tmp/cache:/cache'],
    });

    expect(env.routes.volumes).toEqual([
      'file:///tmp/scratch:/scratch',
      's3://example-bucket:/data',
      'file:///tmp/cache:/cache',
    ]);
  });

  it('parses repeated -v from the command line', () => {
    const argv = process.argv;
    process.argv = ['node', 'rowdy', '-v', '/tmp/scratch:/scratch', '-v', 's3://example-bucket:/data', '--', 'true'];
    try {
      const env = new Environment(new Logger());

      expect(env.routes.volumes).toEqual(['file:///tmp/scratch:/scratch', 's3://example-bucket:/data']);
      expect(env.command).toEqual(['true']);
    } finally {
      process.argv = argv;
    }
  });

  describe('with explicit arguments', () => {
    const withArgv = (argv: string[], run: () => void): void => {
      const original = process.argv;
      process.argv = argv;
      try {
        run();
      } finally {
        process.argv = original;
      }
    };

    it('ignores the host process arguments', () => {
      withArgv(['node', 'app', '-v', '/tmp/scratch:/scratch', '--', 'true'], () => {
        const env = new Environment(new Logger(), []);

        expect(env.routes.volumes).toEqual([]);
        expect(env.command).toBeUndefined();
      });
    });

    it('does not act on the host process --help', () => {
      const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        withArgv(['node', 'app', '--help'], () => {
          new Environment(new Logger(), []);
        });
        expect(exit).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
        log.mockRestore();
      }
    });

    describe('and ROWDY_ variables set', () => {
      beforeEach(() => {
        process.env.ROWDY_VOLUMES = 's3://example-bucket:/data';
        process.env.ROWDY_WORKDIR = '/tmp';
      });

      afterEach(() => {
        delete process.env.ROWDY_VOLUMES;
        delete process.env.ROWDY_WORKDIR;
      });

      it('does not read them', () => {
        const chdir = jest.spyOn(process, 'chdir').mockImplementation(() => undefined);
        try {
          withArgv(['node', 'app'], () => {
            const env = new Environment(new Logger(), []);

            expect(env.routes.volumes).toEqual([]);
            expect(chdir).not.toHaveBeenCalled();
          });
        } finally {
          chdir.mockRestore();
        }
      });

      it('still reads them for the process itself', () => {
        const chdir = jest.spyOn(process, 'chdir').mockImplementation(() => undefined);
        try {
          withArgv(['node', 'rowdy'], () => {
            const env = new Environment(new Logger());

            expect(env.routes.volumes).toEqual(['s3://example-bucket:/data']);
            expect(chdir).toHaveBeenCalledWith('/tmp');
          });
        } finally {
          chdir.mockRestore();
        }
      });
    });

    it('does not announce itself', () => {
      const logger = new Logger();
      const info = jest.spyOn(logger, 'info');
      withArgv(['node', 'app'], () => {
        new Environment(logger, []);
      });
      expect(info).not.toHaveBeenCalled();
    });

    it('announces itself for the process itself', () => {
      const logger = new Logger();
      const info = jest.spyOn(logger, 'info');
      withArgv(['node', 'rowdy'], () => {
        new Environment(logger);
      });
      expect(info).toHaveBeenCalledWith('Rowdy Started', expect.anything());
    });

    it('parses the arguments it was given', () => {
      withArgv(['node', 'app'], () => {
        const env = new Environment(new Logger(), ['-v', '/tmp/scratch:/scratch', '--', 'true']);

        expect(env.routes.volumes).toEqual(['file:///tmp/scratch:/scratch']);
        expect(env.command).toEqual(['true']);
      });
    });
  });

  it('takes a single -v', () => {
    const env = setup({ volume: 's3://example-bucket:/data' });

    expect(env.routes.volumes).toEqual(['s3://example-bucket:/data']);
  });

  it('does not take the next argument after a -v value', () => {
    const argv = process.argv;
    process.argv = ['node', 'rowdy', '-v', '/tmp/scratch:/scratch', 'serve', '--', 'true'];
    try {
      const env = new Environment(new Logger());

      expect(env.routes.volumes).toEqual(['file:///tmp/scratch:/scratch']);
      expect(env.command).toEqual(['true']);
    } finally {
      process.argv = argv;
    }
  });

  it('rejects a docker named volume', () => {
    expect(() => setup({ volume: ['data:/data'] })).toThrow('data:/data');
  });

  it('keeps the routes manifest when no volumes are given', () => {
    const env = setup({ routes: 'volumes:\n  - file:///tmp/scratch:/scratch\n' });

    expect(env.routes.volumes).toEqual(['file:///tmp/scratch:/scratch']);
  });
});
