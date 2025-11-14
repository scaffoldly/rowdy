import { CloudResource } from '@scaffoldly/rowdy-cdk';

export class NullResource extends CloudResource<undefined, undefined> {
  constructor() {
    super(
      {
        describe: (_resource) => ({ type: 'Null', label: 'Null' }),
        read: async (_id) => undefined,
        create: async () => undefined,
        update: async (_resource) => undefined,
        dispose: async (_resource) => undefined,
        emitPermissions: (_aware) => {},
      },
      (_output) => undefined
    );
  }
}
