import type { Client, Logger as SmithyLogger } from '@smithy/types';
import { Observable, Subject } from 'rxjs';
import { inspect } from 'util';
import { CdkEvent, CdkEventType, LIFECYCLES } from './event';
import { Logger, maskJson } from './log';

const TYPES: [RegExp, CdkEventType][] = [
  [/^Describe/, 'describe'],
  [/^(Get|List|Head)/, 'read'],
  [/^(Create|Run|Publish|Add)/, 'create'],
  [/^(Update|Put)/, 'update'],
  [/^(Delete|Terminate)/, 'dispose'],
  [/^Tag/, 'tag'],
];

/**
 * Logs what an AWS SDK client does: a change at info, by name only, and everything at debug. Pass it as a client's
 * `logger`, and `track` the client for its events.
 */
export abstract class ClientLogger implements SmithyLogger {
  private emitted = new Subject<CdkEvent>();

  /**
   * @param changes Matches the name of a command that changes something.
   * @param names The fields that name what a command changes, most specific first, in lower case: AWS's APIs differ in
   * theirs.
   */
  constructor(
    private changes: RegExp,
    private names: string[]
  ) {}

  abstract get log(): Logger;

  /** Each step of every tracked client's commands from now on. A retried command emits once. */
  events(): Observable<CdkEvent> {
    return this.emitted.asObservable();
  }

  /** Emits events for a client's commands. A command that fits no type of event emits nothing. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  track<T extends Client<any, any, any>>(client: T): T {
    client.middlewareStack.add(
      (next, { clientName, commandName }) =>
        async (args) => {
          const type = TYPES.find(([pattern]) => pattern.test(`${commandName}`))?.[1];
          if (!type) {
            return next(args);
          }
          const [before, after] = LIFECYCLES[type];
          const name = this.nameOf(args.input);
          const event = {
            type,
            client: clientName ?? 'UnknownClient',
            action: `${commandName}`.replace(/Command$/, ''),
            ...(name ? { name: `${name}` } : {}),
          };

          this.emitted.next({ ...event, lifecycle: before } as CdkEvent);
          try {
            const output = await next(args);
            this.emitted.next({ ...event, lifecycle: after } as CdkEvent);
            return output;
          } catch (error) {
            this.emitted.next({ ...event, lifecycle: 'failed' });
            throw error;
          }
        },
      { step: 'initialize', name: 'clientLogger', override: true }
    );
    return client;
  }

  // Names only: an input can carry the function's environment.
  private nameOf(input: unknown): unknown {
    const fields = new Map(Object.entries(input ?? {}).map(([field, value]) => [field.toLowerCase(), value]));
    return this.names.map((field) => fields.get(field)).find(Boolean);
  }

  debug = (..._content: unknown[]): void => {};
  info = (...content: unknown[]): void => {
    const obj = Array.isArray(content) && content.length === 1 ? content[0] : content;
    if (typeof obj === 'object') {
      const { clientName, commandName, input, output } = obj as {
        clientName?: string;
        commandName?: string;
        input?: unknown;
        output?: unknown;
      };
      this.log.debug(`[${clientName ?? 'UnknownClient'}] [${commandName ?? 'UnknownCommand'}]`, {
        input: maskJson(input),
        output: maskJson(output),
      });
      if (this.changes.test(`${commandName}`)) {
        const name = this.nameOf(input);
        this.log.info(`${commandName?.replace(/Command$/, '')}${name ? `: ${name}` : ''}`);
      }
    }
  };
  warn = (..._content: unknown[]): void => {};
  error = (..._content: unknown[]): void => {
    const obj = Array.isArray(_content) && _content.length === 1 ? _content[0] : _content;
    if (typeof obj === 'object') {
      const { clientName, commandName, input, error } = obj as {
        clientName?: string;
        commandName?: string;
        input?: unknown;
        error?: unknown;
      };
      this.log.debug(`[${clientName ?? 'UnknownClient'}] [${commandName ?? 'UnknownCommand'}]`, {
        input: maskJson(input),
        error: inspect(error),
      });
      return;
    }
  };
}
