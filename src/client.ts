import type { Client, Logger as SmithyLogger } from '@smithy/types';
import { Observable, Subject } from 'rxjs';
import { inspect } from 'util';
import { CdkEvent, CdkEventType, LIFECYCLES } from './event';
import { Logger, maskJson } from './log';

export type ClientLoggerOptions = {
  /** Which commands are which type, by name. The first match wins. A command with no match isn't logged or emitted. */
  commands: Partial<Record<CdkEventType, RegExp>>;
  /** The fields that name what a command is about, most specific first, in lower case. */
  names: string[];
};

/**
 * Logs what an AWS SDK client does: a change at info, by name only, and everything at debug. Pass it as a client's
 * `logger`, and `track` the client for its events.
 */
export abstract class ClientLogger implements SmithyLogger {
  private emitted = new Subject<CdkEvent>();

  constructor(private options: ClientLoggerOptions) {}

  abstract get log(): Logger;

  /** Each step of every tracked client's commands from now on. A retried command emits once. */
  events(): Observable<CdkEvent> {
    return this.emitted.asObservable();
  }

  /** Emits events for a client's commands. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  track<T extends Client<any, any, any>>(client: T): T {
    client.middlewareStack.add(
      (next, { clientName, commandName }) =>
        async (args): ReturnType<typeof next> => {
          const type = this.typeOf(commandName);
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

  private typeOf(commandName: unknown): CdkEventType | undefined {
    const types = Object.entries(this.options.commands) as [CdkEventType, RegExp][];
    return types.find(([, pattern]) => pattern.test(`${commandName}`))?.[0];
  }

  // Names only: an input can carry the function's environment.
  private nameOf(input: unknown): unknown {
    const fields = new Map(Object.entries(input ?? {}).map(([field, value]) => [field.toLowerCase(), value]));
    return this.options.names.map((field) => fields.get(field)).find(Boolean);
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
      const type = this.typeOf(commandName);
      if (type && type !== 'describe' && type !== 'read') {
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
