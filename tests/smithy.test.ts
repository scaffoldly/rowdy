import { Logger, SmithyClientLogger } from '../src';

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

describe('SmithyClientLogger', () => {
  let client: TestLogger;
  let info: jest.SpyInstance;
  let debug: jest.SpyInstance;

  beforeEach(() => {
    client = new TestLogger();
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

    it('leaves a command it would not log unwalked', () => {
      const output: Record<string, unknown> = {};
      output.Body = output;
      const toJSON = jest.fn(() => ({}));

      client.info({ clientName: 'S3Client', commandName: 'GetObjectCommand', input: { toJSON }, output });

      expect(toJSON).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
    });
  });
});
