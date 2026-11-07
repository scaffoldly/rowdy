import { CdkEvent, ClientLogger, Logger } from '../src';

type Fetch = (path: string, body: unknown) => Promise<string>;
type OtherClient = { request: Fetch };

/** An SDK with its own way in: wrapping the client's function. */
class OtherLogger extends ClientLogger<OtherClient> {
  log = new Logger('other');

  track<T extends OtherClient>(client: T): T {
    const { request } = client;
    client.request = (path, body): Promise<string> =>
      this.around('OtherClient', path, body, () => {
        this.changed(path, body);
        return request(path, body);
      });
    return client;
  }
}

describe('ClientLogger', () => {
  let logger: OtherLogger;
  let events: CdkEvent[];

  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    logger = new OtherLogger({ commands: { create: /^workers\.create/ }, names: ['name'] });
    events = [];
    logger.events().subscribe((event) => events.push(event));
  });

  afterEach(() => jest.restoreAllMocks());

  it('works with any SDK a subclass can wire in', async () => {
    const client = logger.track<OtherClient>({ request: async (): Promise<string> => 'done' });

    expect(await client.request('workers.create', { name: 'worker' })).toBe('done');

    const event = { type: 'create', client: 'OtherClient', action: 'workers.create', name: 'worker' };
    expect(events).toEqual([
      { ...event, lifecycle: 'creating' },
      { ...event, lifecycle: 'created' },
    ]);
  });

  it('runs a command with no match, and emits nothing', async () => {
    const client = logger.track<OtherClient>({ request: async (): Promise<string> => 'done' });

    expect(await client.request('workers.list', {})).toBe('done');

    expect(events).toEqual([]);
  });

  it('emits failed and rethrows', async () => {
    const denied = new Error('denied');
    const client = logger.track<OtherClient>({
      request: async (): Promise<string> => {
        throw denied;
      },
    });

    await expect(client.request('workers.create', {})).rejects.toBe(denied);

    expect(events.map(({ lifecycle }) => lifecycle)).toEqual(['creating', 'failed']);
  });
});
