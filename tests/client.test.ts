import { ClientLogger, Logger } from '../src';

type Fetch = (path: string, body: unknown) => Promise<string>;
type OtherClient = { request: Fetch };

/** An SDK with its own way in: wrapping the client's function. */
class OtherLogger extends ClientLogger {
  constructor(
    public log: Logger,
    options: ConstructorParameters<typeof ClientLogger>[0]
  ) {
    super(options);
  }

  track<T extends OtherClient>(client: T): T {
    const { request } = client;
    client.request = async (path, body): Promise<string> => {
      const output = await request(path, body);
      this.changed(path, body);
      return output;
    };
    return client;
  }
}

describe('ClientLogger', () => {
  let logged: string[];
  let logger: OtherLogger;

  beforeEach(() => {
    logged = [];
    logger = new OtherLogger(new Logger('other', { write: (line): number => logged.push(line) }, 'info'), {
      commands: { create: /^workers\.create/ },
      names: ['name'],
    });
  });

  it('works with any SDK a subclass can wire in', async () => {
    const client = logger.track<OtherClient>({ request: async (): Promise<string> => 'done' });

    expect(await client.request('workers.create', { name: 'worker' })).toBe('done');

    expect(logged).toEqual([expect.stringContaining('workers.create: worker')]);
  });

  it('runs a command with no match, and logs nothing', async () => {
    const client = logger.track<OtherClient>({ request: async (): Promise<string> => 'done' });

    expect(await client.request('workers.list', {})).toBe('done');

    expect(logged).toEqual([]);
  });

  it('rethrows a failed command, and logs no change', async () => {
    const denied = new Error('denied');
    const client = logger.track<OtherClient>({
      request: async (): Promise<string> => {
        throw denied;
      },
    });

    await expect(client.request('workers.create', { name: 'worker' })).rejects.toBe(denied);

    expect(logged).toEqual([]);
  });
});
