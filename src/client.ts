import { inspect } from 'util';
import { Observable, Subject } from 'rxjs';
import { Logger, maskJson } from './log';

/** A change an AWS SDK client made. It has no `type`, so `{ type: 'cdk', ...event }` can add one. */
export type CdkEvent = {
  /** Like `IAMClient`. */
  client: string;
  /** The command without its `Command` suffix, like `CreateRole`. */
  action: string;
  /** What changed. Nothing else from the input: it can carry secrets. */
  name?: string;
};

/** Logs what an AWS SDK client does: a change at info, by name only, and everything at debug. Emits each change. */
export abstract class ClientLogger {
  private changed = new Subject<CdkEvent>();

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

  /** Each change this client makes from now on. */
  events(): Observable<CdkEvent> {
    return this.changed.asObservable();
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
        // Names only: an input can carry the function's environment.
        const fields = new Map(Object.entries(input ?? {}).map(([field, value]) => [field.toLowerCase(), value]));
        const name = this.names.map((field) => fields.get(field)).find(Boolean);
        const action = `${commandName?.replace(/Command$/, '')}`;
        this.log.info(`${action}${name ? `: ${name}` : ''}`);
        this.changed.next({
          client: clientName ?? 'UnknownClient',
          action,
          ...(name ? { name: `${name}` } : {}),
        });
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
