import { CloudResource, FatalException } from '../src';

type Role = { RoleName: string };
type Output = { Role: Role };

const resource = (
  requests: Partial<ConstructorParameters<typeof CloudResource<Role, Output>>[0]> = {}
): CloudResource<Role, Output> =>
  new CloudResource<Role, Output>(
    {
      describe: ({ RoleName }): { type: string; label?: string } => ({ type: 'IAM Role', label: RoleName }),
      read: async (): Promise<Output> => ({ Role: { RoleName: 'role' } }),
      ...requests,
    },
    (output) => output.Role
  );

describe('cdk', () => {
  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps the error of a failed read', async () => {
    const fatal = new FatalException('nope');
    const role = resource({
      read: async () => {
        throw fatal;
      },
    });

    await expect(role.manage()).rejects.toBe(fatal);
  });

  it('calls back', async () => {
    const callback = jest.fn();
    const role = resource({ update: async () => ({}) });

    await role.callback(callback).manage();

    expect(callback).toHaveBeenCalledWith('Updated', 'notice', 'IAM Role', 'role');
  });
});
