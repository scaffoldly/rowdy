import { CdkEvent, ClientLogger, Logger } from '../src';

class TestLogger extends ClientLogger {
  log = new Logger('test');

  constructor() {
    super(/^(?!.*AuthToken)(Create|Run)/, ['rolename', 'name']);
  }
}

describe('ClientLogger', () => {
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

  const change = (input: unknown = { RoleName: 'role' }, commandName = 'CreateRoleCommand'): void =>
    client.info({ clientName: 'IAMClient', commandName, input, output: {} });

  it('emits a change', () => {
    change();

    expect(events).toEqual([{ client: 'IAMClient', action: 'CreateRole', name: 'role' }]);
  });

  it('logs a change at info', () => {
    change();

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain('CreateRole: role');
  });

  it('leaves out a name it can not find', () => {
    change({});

    expect(events).toEqual([{ client: 'IAMClient', action: 'CreateRole' }]);
  });

  it('takes the first of its names, whatever the case of the field', () => {
    change({ Name: 'second', ROLENAME: 'first' });

    expect(events[0]?.name).toBe('first');
  });

  it('emits nothing from an input but the name', () => {
    change({ RoleName: 'role', Environment: { TOKEN: 'secret' } });

    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('has no type, so one can be added', () => {
    change();

    expect(events[0]).not.toHaveProperty('type');
  });

  it('ignores a command that changes nothing', () => {
    change({ RoleName: 'role' }, 'GetRoleCommand');

    expect(events).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it('follows the pattern it was given', () => {
    change({ name: 'vm' }, 'CreateMicrovmAuthTokenCommand');

    expect(events).toEqual([]);
  });

  it('logs every command at debug', () => {
    new Logger().withLevel('debug');

    change({ RoleName: 'role' }, 'GetRoleCommand');

    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('keeps each client to its own events', () => {
    const other = new TestLogger();
    const others: CdkEvent[] = [];
    other.events().subscribe((event) => others.push(event));

    change();

    expect(events).toHaveLength(1);
    expect(others).toEqual([]);
  });

  it('emits nothing for a failure', () => {
    client.error({ clientName: 'IAMClient', commandName: 'CreateRoleCommand', input: {}, error: new Error('denied') });

    expect(events).toEqual([]);
  });

  it('ignores content that is not an object', () => {
    client.info('hello');

    expect(events).toEqual([]);
  });
});
