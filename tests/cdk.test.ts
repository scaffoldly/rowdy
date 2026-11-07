import { CdkEvent, CloudResource, FatalException, NotFoundException } from '../src';

type Role = { RoleName: string };
type Output = { Role: Role };

const resource = (
  requests: Partial<ConstructorParameters<typeof CloudResource<Role, Output>>[0]> = {}
): { role: CloudResource<Role, Output>; events: CdkEvent[] } => {
  const role = new CloudResource<Role, Output>(
    {
      describe: ({ RoleName }): { type: string; label?: string } => ({ type: 'IAM Role', label: RoleName }),
      read: async (): Promise<Output> => ({ Role: { RoleName: 'role' } }),
      ...requests,
    },
    (output) => output.Role
  );
  const events: CdkEvent[] = [];
  role.events().subscribe((event) => events.push(event));
  return { role, events };
};

const steps = (events: CdkEvent[]): string[] =>
  events.filter(({ type }) => type !== 'describe').map(({ type, lifecycle }) => `${type}:${lifecycle}`);

describe('cdk', () => {
  describe('events', () => {
    beforeEach(() => {
      jest.spyOn(console, 'info').mockImplementation(() => {});
    });

    afterEach(() => jest.restoreAllMocks());

    it('emits reading and read', async () => {
      const { role, events } = resource();

      await role.manage();

      expect(steps(events)).toEqual(['read:reading', 'read:read']);
    });

    it('names the resource', async () => {
      const { role, events } = resource();

      await role.manage();

      expect(events[events.length - 1]).toEqual({
        type: 'read',
        lifecycle: 'read',
        resource: 'IAM Role',
        name: 'role',
      });
    });

    it('emits describing and described', async () => {
      const { role, events } = resource();

      await role.manage();

      expect(events.slice(0, 2)).toEqual([
        { type: 'describe', lifecycle: 'describing' },
        { type: 'describe', lifecycle: 'described', resource: 'IAM Role' },
      ]);
    });

    it('emits updating and updated for what exists', async () => {
      const { role, events } = resource({ update: async () => ({}) });

      await role.manage();

      expect(steps(events)).toEqual([
        'read:reading',
        'read:read',
        'update:updating',
        'read:reading',
        'read:read',
        'update:updated',
      ]);
    });

    it('emits creating and created for what does not', async () => {
      let exists = false;
      const { role, events } = resource({
        read: async () => {
          if (!exists) throw new NotFoundException('role');
          return { Role: { RoleName: 'role' } };
        },
        create: async () => (exists = true),
      });

      await role.manage();

      expect(steps(events)).toEqual([
        'read:reading',
        'read:read',
        'create:creating',
        'read:reading',
        'read:read',
        'create:created',
      ]);
    });

    it('emits tagging and tagged', async () => {
      const { role, events } = resource({ tag: async () => ({}) });

      await role.manage();

      expect(steps(events)).toEqual([
        'read:reading',
        'read:read',
        'tag:tagging',
        'read:reading',
        'read:read',
        'tag:tagged',
      ]);
    });

    it('emits disposing and disposed', async () => {
      const { role, events } = resource({ dispose: async () => ({}) });

      await role.dispose().manage();

      expect(steps(events)).toEqual(['read:reading', 'read:read', 'dispose:disposing', 'dispose:disposed']);
    });

    it('emits failed for a failed step', async () => {
      const { role, events } = resource({
        update: async () => {
          throw Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
        },
      });

      await role.manage();

      expect(steps(events)).toEqual(['read:reading', 'read:read', 'update:updating', 'update:failed']);
    });

    it('emits failed for a failed read, and keeps its error', async () => {
      const fatal = new FatalException('nope');
      const { role, events } = resource({
        read: async () => {
          throw fatal;
        },
      });

      await expect(role.manage()).rejects.toBe(fatal);

      expect(steps(events)).toEqual(['read:reading', 'read:failed']);
    });

    it('still calls back', async () => {
      const callback = jest.fn();
      const { role } = resource({ update: async () => ({}) });

      await role.callback(callback).manage();

      expect(callback).toHaveBeenCalledWith('Updated', 'notice', 'IAM Role', 'role');
    });
  });
});
