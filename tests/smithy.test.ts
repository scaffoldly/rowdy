import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { CdkEvent, Logger, SmithyClientLogger } from '../src';

class TestLogger extends SmithyClientLogger {
  log = new Logger('test');

  constructor() {
    super({
      commands: {
        describe: /^Describe/,
        read: /^(Get|List|Head)/,
        create: /^(?!.*AuthToken)(Create|Run)/,
        update: /^Put/,
        dispose: /^Terminate/,
        tag: /^Tag/,
      },
      names: ['rolename', 'name'],
    });
  }
}

type Handler = (args: { input: unknown }) => Promise<unknown>;
type Middleware = (next: Handler, context: { clientName?: string; commandName?: string }) => Handler;

/** Tracks a stand-in client and hands back its middleware, to run as a command would. */
const tracked = (
  logger: SmithyClientLogger
): ((command: string, input?: unknown, next?: Handler) => Promise<unknown>) => {
  let middleware: Middleware | undefined;
  const client = { middlewareStack: { add: (added: Middleware): Middleware => (middleware = added) } };
  logger.track(client as never);
  return (commandName, input = {}, next = async (): Promise<unknown> => ({})) =>
    middleware!(next, { clientName: 'IAMClient', commandName })({ input });
};

describe('SmithyClientLogger', () => {
  let client: TestLogger;
  let events: CdkEvent[];
  let info: jest.SpyInstance;
  let debug: jest.SpyInstance;

  beforeEach(() => {
    client = new TestLogger();
    events = [];
    client.events().subscribe((event) => events.push(event));
    info = jest.spyOn(console, 'info').mockImplementation(() => {});
    debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    new Logger().withLevel('info');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    new Logger().withLevel(undefined);
  });

  describe('logging', () => {
    const logged = (commandName: string, input: unknown = { RoleName: 'role' }): void =>
      client.info({ clientName: 'IAMClient', commandName, input, output: {} });

    it('logs a change at info, by name', () => {
      logged('CreateRoleCommand');

      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0]?.[0]).toContain('CreateRole: role');
    });

    it('takes the first of its names, whatever the case of the field', () => {
      logged('CreateRoleCommand', { Name: 'second', ROLENAME: 'first' });

      expect(info.mock.calls[0]?.[0]).toContain('CreateRole: first');
    });

    it('leaves reads at debug', () => {
      logged('GetRoleCommand');
      logged('DescribeRepositoriesCommand');

      expect(info).not.toHaveBeenCalled();
    });

    it('logs a tag at info', () => {
      logged('TagRoleCommand');

      expect(info).toHaveBeenCalledTimes(1);
    });

    it('follows the patterns it was given', () => {
      logged('CreateMicrovmAuthTokenCommand');

      expect(info).not.toHaveBeenCalled();
    });

    it('logs every command at debug', () => {
      new Logger().withLevel('debug');

      logged('GetRoleCommand');

      expect(debug).toHaveBeenCalledTimes(1);
    });

    it('emits nothing itself', () => {
      logged('CreateRoleCommand');

      expect(events).toEqual([]);
    });
  });

  describe('track', () => {
    it('returns the client it was given', () => {
      const sts = new STSClient({ region: 'us-east-1' });

      expect(client.track(sts)).toBe(sts);
    });

    it('emits before and after a command', async () => {
      await tracked(client)('CreateRoleCommand', { RoleName: 'role' });

      const event = { type: 'create', client: 'IAMClient', action: 'CreateRole', name: 'role' };
      expect(events).toEqual([
        { ...event, lifecycle: 'creating' },
        { ...event, lifecycle: 'created' },
      ]);
    });

    it('emits before the command runs', async () => {
      let seen = 0;

      await tracked(client)('CreateRoleCommand', {}, async () => (seen = events.length));

      expect(seen).toBe(1);
    });

    it.each([
      ['DescribeRepositoriesCommand', 'describe', 'describing', 'described'],
      ['GetRoleCommand', 'read', 'reading', 'read'],
      ['CreateRoleCommand', 'create', 'creating', 'created'],
      ['PutObjectCommand', 'update', 'updating', 'updated'],
      ['TerminateMicrovmCommand', 'dispose', 'disposing', 'disposed'],
      ['TagResourceCommand', 'tag', 'tagging', 'tagged'],
    ])('types %s', async (command, type, before, after) => {
      await tracked(client)(command);

      expect(events.map((event) => [event.type, event.lifecycle])).toEqual([
        [type, before],
        [type, after],
      ]);
    });

    it('emits nothing for a command that matches no pattern', async () => {
      await tracked(client)('InvokeWithResponseStreamCommand');

      expect(events).toEqual([]);
    });

    it('has no opinion of its own on a command', async () => {
      class Bare extends SmithyClientLogger {
        log = new Logger('bare');
      }
      const bare = new Bare({ commands: { create: /^Invoke/ }, names: [] });
      const seen: CdkEvent[] = [];
      bare.events().subscribe((event) => seen.push(event));

      await tracked(bare)('GetRoleCommand');
      await tracked(bare)('InvokeWithResponseStreamCommand');

      expect(seen.map(({ action, lifecycle }) => [action, lifecycle])).toEqual([
        ['InvokeWithResponseStream', 'creating'],
        ['InvokeWithResponseStream', 'created'],
      ]);
    });

    it('emits failed and rethrows when a command fails', async () => {
      const denied = new Error('denied');

      await expect(
        tracked(client)('CreateRoleCommand', {}, async () => {
          throw denied;
        })
      ).rejects.toBe(denied);

      expect(events.map(({ lifecycle }) => lifecycle)).toEqual(['creating', 'failed']);
    });

    it('leaves out a name it can not find', async () => {
      await tracked(client)('CreateRoleCommand');

      expect(events[0]).not.toHaveProperty('name');
    });

    it('emits nothing from an input but the name', async () => {
      await tracked(client)('CreateRoleCommand', { RoleName: 'role', Environment: { TOKEN: 'secret' } });

      expect(JSON.stringify(events)).not.toContain('secret');
    });

    it('keeps each logger to its own events', async () => {
      const other = new TestLogger();
      const others: CdkEvent[] = [];
      other.events().subscribe((event) => others.push(event));

      await tracked(client)('CreateRoleCommand');

      expect(others).toEqual([]);
    });

    it('works on a real client, once per command across retries', async () => {
      let attempts = 0;
      const sts = client.track(
        new STSClient({
          region: 'us-east-1',
          credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example' },
          maxAttempts: 2,
          retryStrategy: undefined,
          requestHandler: {
            handle: async (): Promise<never> => {
              attempts += 1;
              throw Object.assign(new Error('throttled'), { name: 'ThrottlingException', $retryable: {} });
            },
          },
        })
      );

      await expect(sts.send(new GetCallerIdentityCommand({}))).rejects.toThrow('throttled');

      expect(attempts).toBe(2);
      expect(events).toEqual([
        { type: 'read', lifecycle: 'reading', client: 'STSClient', action: 'GetCallerIdentity' },
        { type: 'read', lifecycle: 'failed', client: 'STSClient', action: 'GetCallerIdentity' },
      ]);
    });
  });
});
