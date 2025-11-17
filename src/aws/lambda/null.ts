import { CloudResource } from '@scaffoldly/rowdy-cdk';

export class TodoResource extends CloudResource<string, { todo: string }> {
  constructor() {
    super(
      {
        describe: (resource) => ({ type: 'Todo', label: resource }),
        read: async () => {
          return { todo: 'not implemented' };
        },
        create: async () => undefined,
        update: async (_resource) => undefined,
        tag: async (_resource, _tags) => undefined,
        dispose: async (_resource) => undefined,
      },
      (output) => output.todo
    );
  }
}
