import promiseRetry from 'promise-retry';
import { Observable, Subject } from 'rxjs';
import { CdkEvent, CdkEventType, LIFECYCLES } from './event';
import { getDifferences } from './internal/diff';
import { log as root } from './log';
import packageJson from '../package.json';
const VERSION = packageJson.version;
const NAME = packageJson.name;

const log = root.child('cdk');

type LogAction =
  | 'Reading'
  | 'Read'
  | 'Creating'
  | 'Created'
  | 'Updating'
  | 'Updated'
  | 'Tagging'
  | 'Tagged'
  | 'Deleting'
  | 'Deleted';

const EVENTS: Record<LogAction, [CdkEventType, 0 | 1]> = {
  Reading: ['read', 0],
  Read: ['read', 1],
  Creating: ['create', 0],
  Created: ['create', 1],
  Updating: ['update', 0],
  Updated: ['update', 1],
  Tagging: ['tag', 0],
  Tagged: ['tag', 1],
  Deleting: ['dispose', 0],
  Deleted: ['dispose', 1],
};

type CallbackAction =
  | 'Created'
  | 'Updated'
  | 'Tagged'
  | 'Deleted'
  | 'Failed to Create'
  | 'Failed to Update'
  | 'Failed to Tag'
  | 'Failed to Delete';

type ResourceOptions = {
  retries?: number;
  readOnly?: boolean;
  stateless?: boolean;
  dispose?: boolean;
  callback?: (action: CallbackAction, level: 'notice' | 'error', type: string, label: string | undefined) => void;
};

type ResourceExtractor<Resource, ReadCommandOutput> = (
  output: Partial<ReadCommandOutput>
) => Partial<Resource> | undefined;

export class NotFoundException extends Error {
  constructor(message: string, cause?: Error) {
    if (!cause) {
      super(`Not Found: ${message}`);
    } else {
      super(`Not Found: ${message}: ${cause}`);
    }
    this.name = 'NotFoundException';
  }
}

export class FatalException extends Error {
  constructor(message: string, cause?: Error) {
    if (!cause) {
      super(`Fatal: ${message}`);
    } else {
      super(`Fatal: ${message}: ${cause}`);
    }
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
  private _tags: Record<string, string> = {};
  private _output?: Partial<ReadCommandOutput>;
  private _resource?: Partial<Resource>;
  private emitted = new Subject<CdkEvent>();

  constructor(
    public readonly requests: {
      describe: (resource: Partial<Resource>) => { type: string; label?: string };
      read: (id?: unknown) => Promise<ReadCommandOutput>;
      create?: () => Promise<unknown>;
      update?: (resource: Partial<Resource>) => Promise<unknown>;
      dispose?: (resource: Partial<Resource>) => Promise<unknown>;
      tag?: (resource: Partial<Resource>, tags: Record<string, string>) => Promise<unknown>;
    },
    public readonly resourceExtractor: ResourceExtractor<Resource, ReadCommandOutput>,
    tags: Record<string, string> = {}
  ) {
    this._tags = tags;
  }

  /** Each step of managing this resource from now on. */
  events(): Observable<CdkEvent> {
    return this.emitted.asObservable();
  }

  get Output(): PromiseLike<Partial<ReadCommandOutput>> {
    if (this.options.stateless) {
      throw new Error('Cannot get Output of stateless resource');
    }

    if (this._output) {
      return Promise.resolve(this._output);
    }
    return this.manage().then(() => this.Output);
  }

  get Resource(): PromiseLike<Partial<Resource>> {
    if (this.options.stateless) {
      return this.manage();
    }

    if (this._resource) {
      return Promise.resolve(this._resource);
    }
    return this.manage().then(() => this.Resource);
  }

  get Tags(): Record<string, string> {
    return {
      ...this._tags,
      'managed-by': `${NAME}@${VERSION}`,
    };
  }

  then<TResult1 = Partial<Resource>, TResult2 = never>(
    onfulfilled?: ((value: Partial<Resource>) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): PromiseLike<TResult1 | TResult2> {
    return this._manage(this.desired).then(onfulfilled, onrejected);
  }

  public manage(desired?: Partial<ReadCommandOutput>): CloudResource<Resource, ReadCommandOutput> {
    this.desired = desired;
    return this;
  }

  private async _manage(desired?: Partial<ReadCommandOutput>): Promise<Partial<Resource>> {
    let existing = await this._read(desired);
    if (this.options.readOnly) {
      return existing || {};
    }

    if (this.options.dispose) {
      return (await this._dispose(existing || {})) || {};
    }

    if (existing) {
      try {
        existing = await this._update(existing, desired);
      } catch (e) {
        if (!(e instanceof Error)) {
          throw e;
        }
      }
    } else {
      try {
        existing = await this._create(desired);
      } catch (e) {
        if (!(e instanceof Error)) {
          throw e;
        }
      }
    }

    if (!existing) {
      throw new Error(`Failed to manage ${this.requests.describe({}).type}`);
    }

    try {
      existing = await this._tag(existing, desired);
    } catch (e) {
      if (!(e instanceof Error)) {
        throw e;
      }
    }

    if (!existing) {
      throw new Error(`Failed to tag ${this.requests.describe({}).type}`);
    }

    return existing;
  }

  private async _read(desired?: Partial<ReadCommandOutput>): Promise<Partial<Resource> | undefined> {
    this._log('Reading', {});
    const response = await promiseRetry(
      async (retry) => {
        try {
          const readResponse = await this.requests.read();

          const difference = getDifferences(desired || {}, readResponse);

          if (Object.keys(difference).length) {
            return retry(new Error('Resource is not ready'));
          }

          const resource = this.resourceExtractor(readResponse);

          if (!this.options.stateless) {
            this._output = readResponse;
            this._resource = resource;
          }

          return resource;
        } catch (e) {
          delete this._output;
          delete this._resource;
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
        retries: this.options.retries !== Infinity ? this.options.retries || 0 : 0,
        forever: this.options.retries === Infinity,
      }
    ).catch((e) => {
      const { type, label } = this._describe({});
      this.emitted.next({ type: 'read', lifecycle: 'failed', resource: type, ...(label ? { name: label } : {}) });
      // A caller tells these apart by class, so it can't go through _log.
      throw e;
    });

    this._log('Read', response ?? {});
    return response;
  }

  private async _create(desired?: Partial<ReadCommandOutput>): Promise<Partial<Resource> | undefined> {
    const { create } = this.requests;
    if (!create) {
      return undefined;
    }

    this._log('Creating', {});
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
        retries: this.options.retries !== Infinity ? this.options.retries || 0 : 0,
        forever: this.options.retries === Infinity,
      }
    ).catch((e) => this._log('Created', e));

    const resource = await this._read(desired);
    this._log('Created', resource);

    return resource;
  }

  private async _update(
    existing: Partial<Resource>,
    desired?: Partial<ReadCommandOutput>
  ): Promise<Partial<Resource> | undefined> {
    const { update } = this.requests;
    if (!update) {
      return existing;
    }

    this._log('Updating', existing);
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
        retries: this.options.retries !== Infinity ? this.options.retries || 0 : 0,
        forever: this.options.retries === Infinity,
      }
    ).catch((e) => this._log('Updated', e));

    const resource = await this._read(desired);
    this._log('Updated', resource);

    return resource;
  }

  private async _dispose(existing: Partial<Resource>): Promise<Partial<Resource> | undefined> {
    const { dispose } = this.requests;
    if (!dispose) {
      throw new Error('Dispose operation not provided');
    }

    this._log('Deleting', existing);
    await promiseRetry(
      (retry) =>
        dispose(existing).catch((e) => {
          if ('$metadata' in e && 'httpStatusCode' in e.$metadata && e.$metadata.httpStatusCode === 404) {
            return {} as Partial<Resource>;
          }

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
        retries: this.options.retries !== Infinity ? this.options.retries || 0 : 0,
        forever: this.options.retries === Infinity,
      }
    ).catch((e) => this._log('Deleted', e));

    this._log('Deleted', existing);
    return existing;
  }

  private async _tag(
    existing: Partial<Resource>,
    desired?: Partial<ReadCommandOutput>
  ): Promise<Partial<Resource> | undefined> {
    const { tag } = this.requests;
    if (!tag) {
      return existing;
    }

    this._log('Tagging', existing);
    await promiseRetry(
      (retry) =>
        tag(existing, this.Tags).catch((e) => {
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
        retries: this.options.retries !== Infinity ? this.options.retries || 0 : 0,
        forever: this.options.retries === Infinity,
      }
    ).catch((e) => this._log('Tagged', e));

    const resource = await this._read(desired);
    this._log('Tagged', resource);

    return resource;
  }

  private _describe(resource: Partial<Resource>): { type: string; label?: string } {
    const [before, after] = LIFECYCLES.describe;
    this.emitted.next({ type: 'describe', lifecycle: before });
    const description = this.requests.describe(resource);
    this.emitted.next({
      type: 'describe',
      lifecycle: after,
      resource: description.type,
      ...(description.label ? { name: description.label } : {}),
    });
    return description;
  }

  private _log(action: LogAction, resource: Partial<Resource | undefined> | Error): void {
    let verb: LogAction | 'Failed to Create' | 'Failed to Update' | 'Failed to Tag' | 'Failed to Delete' = action;
    let type = 'Resource';
    let label: string;

    if (resource instanceof Error) {
      switch (action) {
        case 'Created':
          verb = 'Failed to Create';
          break;
        case 'Updated':
          verb = 'Failed to Update';
          break;
        case 'Tagged':
          verb = 'Failed to Tag';
          break;
        case 'Deleted':
          verb = 'Failed to Delete';
          break;
      }
      const description = this._describe({});
      type = description.type;
      label = description.label || '[computed]';
    } else {
      const description = this._describe(resource || {});
      type = description.type;
      label = description.label || '[computed]';
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

    const [eventType, step] = EVENTS[action];
    this.emitted.next({
      type: eventType,
      lifecycle: resource instanceof Error ? 'failed' : LIFECYCLES[eventType][step],
      resource: type,
      ...(label === '[computed]' ? {} : { name: label }),
    } as CdkEvent);

    switch (verb) {
      case 'Created':
      case 'Updated':
      case 'Tagged':
      case 'Deleted':
      case 'Failed to Create':
      case 'Failed to Update':
      case 'Failed to Tag':
      case 'Failed to Delete':
        log.info(messageOutput);
        this.options.callback?.(
          verb,
          resource instanceof Error ? 'error' : 'notice',
          type,
          label === '[computed]' ? undefined : label
        );
        break;
      default:
        log.debug(messageOutput);
        break;
    }

    if (resource instanceof Error) {
      throw new Error(`Unable to manage resource: ${resource}`);
    }
  }

  public stateless(): this {
    this.options.stateless = true;
    return this;
  }

  public readOnly(): this {
    this.options.readOnly = true;
    return this;
  }

  public retries(retries: number): this {
    this.options.retries = retries;
    return this;
  }

  public callback(callback: ResourceOptions['callback']): this {
    this.options.callback = callback;
    return this;
  }

  public dispose(): this {
    this.options.dispose = true;
    return this;
  }

  public withTag(key: string, value: string): this {
    this._tags[key] = value;
    return this;
  }
}
