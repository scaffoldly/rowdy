import { CloudResource } from '@scaffoldly/rowdy-cdk';

export class NullResource extends CloudResource<undefined, undefined> {
  constructor() {
    super(
      {
        describe: (_resource) => ({ type: 'Null' }),
        read: async (_id) => undefined,
        create: async () => undefined,
        update: async (_resource) => undefined,
        dispose: async (_resource) => undefined,
      },
      (_output) => undefined
    );
  }
}
