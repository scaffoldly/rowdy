import promiseRetry from 'promise-retry';
import { getDifferences } from './internal/diff';
import { log as consoleLog } from 'console';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const log = (message?: any, ...optionalParams: any[]): void => {
  consoleLog('[cdk] ' + message, ...optionalParams);
};

type NotifyAction = '✨' | 'Created' | 'Updated' | 'Failed to Create' | 'Failed to Update';

interface PermissionAware {
  withPermissions(permissions: string[]): void;
  get permissions(): string[];
}

type ResourceOptions = {
  retries?: number;
  notify?: (action: NotifyAction, resourceType: string, resourceMessage: string, level?: 'notice' | 'error') => void;
  permissionsAware?: PermissionAware;
};

type ResourceExtractor<Resource, ReadCommandOutput> = (
  output: Partial<ReadCommandOutput>
) => Partial<Resource> | undefined;

export class NotFoundException extends Error {
  constructor(message: string, cause?: Error) {
    super(`Not Found: ${message}: ${cause}`);
    this.name = 'NotFoundException';
  }
}

export class FatalException extends Error {
  constructor(message: string, cause?: Error) {
    super(`Not Found: ${message}: ${cause}`);
    this.name = 'NotFoundException';
  }
}

export class SkipAction extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkipAction';
  }
}

export class CloudResource<Resource, ReadCommandOutput> implements PromiseLike<Partial<Resource>> {
  private options: ResourceOptions = {};

  private desired?: Partial<ReadCommandOutput>;

  constructor(
    protected readonly requests: {
      describe: (resource: Partial<Resource>) => { type: string; label: string };
      read: (id?: unknown) => Promise<ReadCommandOutput>;
      create?: () => Promise<unknown>;
      update?: (resource: Partial<Resource>) => Promise<unknown>;
      dispose?: (resource: Partial<Resource>) => Promise<unknown>;
      emitPermissions?: (aware: PermissionAware) => void;
    },
    protected readonly resourceExtractor: ResourceExtractor<Resource, ReadCommandOutput>
  ) {}

  then<TResult1 = Partial<Resource>, TResult2 = never>(
    onfulfilled?: ((value: Partial<Resource>) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): PromiseLike<TResult1 | TResult2> {
    return this._manage(this.options, this.desired).then(onfulfilled, onrejected);
  }

  public async read(id: unknown): Promise<Partial<Resource> | undefined> {
    return this.requests.read(id).then((output) => {
      return this.resourceExtractor(output);
    });
  }

  public manage(
    options: ResourceOptions,
    desired?: Partial<ReadCommandOutput>
  ): CloudResource<Resource, ReadCommandOutput> {
    this.options = options;
    this.desired = desired;
    return this;
  }

  async _manage(options: ResourceOptions, desired?: Partial<ReadCommandOutput>): Promise<Partial<Resource>> {
    const { emitPermissions } = this.requests;
    if (emitPermissions && options.permissionsAware) {
      emitPermissions(options.permissionsAware);
    }

    this.logResource('Reading', {}, options);
    let existing = await this._read(options);

    if (existing) {
      try {
        this.logResource('Updating', existing, options);
        existing = await this.update(options, existing, desired);
        this.logResource('Updated', existing, options);
      } catch (e) {
        if (!(e instanceof Error)) {
          throw e;
        }
        this.logResource('Updated', e, options);
      }
    } else {
      try {
        this.logResource('Creating', existing, options);
        existing = await this.create(options, desired);
        this.logResource('Created', existing, options);
      } catch (e) {
        if (!(e instanceof Error)) {
          throw e;
        }
        this.logResource('Created', e, options);
      }
    }

    if (!existing) {
      throw new Error(`Failed to manage ${this.requests.describe({}).type}`);
    }

    return existing;
  }

  public async dispose(): Promise<Partial<Resource>> {
    const existing = await this;

    if (!existing) {
      return {} as Partial<Resource>;
    }

    const { dispose } = this.requests;
    if (!dispose) {
      return existing;
    }

    await dispose(existing).catch(() => {});
    const current = await this._read(this.options).catch(() => ({}) as Partial<Resource>);

    if (!current) {
      return {} as Partial<Resource>;
    }

    return current;
  }

  private async _read(options: ResourceOptions, desired?: Partial<unknown>): Promise<Partial<Resource> | undefined> {
    const { read } = this.requests;
    if (!read) {
      return undefined;
    }

    const response = await promiseRetry(
      async (retry) => {
        try {
          const readResponse = await read();

          const difference = getDifferences(desired || {}, readResponse);

          if (Object.keys(difference).length) {
            return retry(new Error('Resource is not ready'));
          }

          const resource = this.resourceExtractor(readResponse);

          return resource;
        } catch (e) {
          if (!(e instanceof Error)) {
            throw e;
          }
          if (e instanceof NotFoundException) {
            return undefined;
          }
          if (
            typeof e === 'object' &&
            '$metadata' in e &&
            typeof e.$metadata === 'object' &&
            e.$metadata !== null &&
            'httpStatusCode' in e.$metadata &&
            e.$metadata.httpStatusCode === 404
          ) {
            return undefined;
          }
          if ('__type' in e && typeof e.__type === 'string' && e.__type.endsWith('NotFoundException')) {
            return undefined;
          }
          if (e instanceof FatalException) {
            throw e;
          }
          return retry(e);
        }
      },
      {
        retries: options.retries !== Infinity ? options.retries || 0 : 0,
        forever: options.retries === Infinity,
      }
    );

    return response;
  }

  private async create(
    options: ResourceOptions,
    desired?: Partial<ReadCommandOutput>
  ): Promise<Partial<Resource> | undefined> {
    const { create } = this.requests;

    if (!create) {
      return undefined;
    }

    await promiseRetry(
      (retry) =>
        create().catch((e) => {
          if (
            '$metadata' in e &&
            'httpStatusCode' in e.$metadata &&
            (e.$metadata.httpStatusCode === 403 || e.$metadata.httpStatusCode === 401)
          ) {
            throw e;
          }

          if (e instanceof FatalException) {
            throw e;
          }

          return retry(e);
        }),
      {
        retries: options.retries !== Infinity ? options.retries || 0 : 0,
        forever: options.retries === Infinity,
      }
    );

    const resource = await this._read(options, desired);

    return resource;
  }

  private async update(
    options: ResourceOptions,
    existing: Partial<Resource>,
    desired?: Partial<ReadCommandOutput>
  ): Promise<Partial<Resource> | undefined> {
    const { update } = this.requests;
    if (!update) {
      return existing;
    }

    await promiseRetry(
      (retry) =>
        update(existing).catch((e) => {
          if (
            '$metadata' in e &&
            'httpStatusCode' in e.$metadata &&
            (e.$metadata.httpStatusCode === 403 || e.$metadata.httpStatusCode === 401)
          ) {
            throw e;
          }

          if (e instanceof FatalException) {
            throw e;
          }

          return retry(e);
        }),
      {
        retries: options.retries !== Infinity ? options.retries || 0 : 0,
        forever: options.retries === Infinity,
      }
    );

    const resource = await this._read(options, desired);

    return resource;
  }

  logResource(
    action: 'Reading' | 'Creating' | 'Created' | 'Updating' | 'Updated',
    resource: Partial<Resource | undefined> | Error,
    options: ResourceOptions
  ): void {
    let verb:
      | '✨'
      | 'Reading'
      | 'Creating'
      | 'Created'
      | 'Updating'
      | 'Updated'
      | 'Failed to Create'
      | 'Failed to Update' = action;
    let emoji = '🤔';
    let type = 'Resource';
    let label: string | undefined;

    switch (action) {
      case 'Created':
      case 'Updated':
        emoji = '✅';
        break;
      case 'Reading':
      case 'Creating':
      case 'Updating':
        emoji = '';
        break;
    }

    if (resource instanceof Error) {
      emoji = '❌';
      switch (action) {
        case 'Created':
          verb = 'Failed to Create';
          break;
        case 'Updated':
          verb = 'Failed to Update';
          break;
      }
      const description = this.requests.describe({});
      type = description.type;
      label = description.label;
    } else {
      const description = this.requests.describe(resource || {});
      type = description.type;
      label = description.label;
    }

    const message = `${verb} ${type}`;
    let resourceMessage = '';

    if (typeof resource === 'string') {
      resourceMessage = resource;
    } else if (resource instanceof Error) {
      resourceMessage = resource.message;
    } else if (label) {
      resourceMessage = label;
    }

    let messageOutput = message;
    if (resourceMessage) {
      messageOutput = `${messageOutput}: ${resourceMessage}`;
    }

    if (resource instanceof SkipAction) {
      return;
    }

    switch (verb) {
      case 'Created':
      case 'Updated':
      case 'Failed to Create':
      case 'Failed to Update':
        log(`${emoji ? `${emoji} ` : ''}${messageOutput}`);
        if (options.notify) {
          options.notify(verb, type, resourceMessage, resource instanceof Error ? 'error' : 'notice');
        }
        break;
      case 'Reading':
      case 'Creating':
      case 'Updating':
        log(messageOutput);
        break;
    }

    if (resource instanceof Error) {
      throw new Error(`Unable to manage resource: ${resource}`);
    }
  }
}
