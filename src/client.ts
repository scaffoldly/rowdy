import { Observable, Subject } from 'rxjs';
import { CdkEvent, CdkEventType, LIFECYCLES } from './event';
import { Logger } from './log';

export type ClientLoggerOptions = {
  /** Which commands are which type, by name. The first match wins. A command with no match isn't logged or emitted. */
  commands: Partial<Record<CdkEventType, RegExp>>;
  /** The fields that name what a command is about, most specific first, in lower case. */
  names: string[];
};

/** Logs what a cloud SDK's client does, and emits each step. A subclass wires this into its SDK. */
export abstract class ClientLogger<Client = unknown> {
  private emitted = new Subject<CdkEvent>();

  constructor(private options: ClientLoggerOptions) {}

  abstract get log(): Logger;

  /** Adds this SDK's interceptor to a client, so `around` sees its commands. */
  abstract track<T extends Client>(client: T): T;

  /** Each step of every tracked client's commands from now on. */
  events(): Observable<CdkEvent> {
    return this.emitted.asObservable();
  }

  /** Emits before and after a command. For an interceptor to call once per command. */
  protected async around<Output>(
    client: string,
    action: string,
    input: unknown,
    run: () => Promise<Output>
  ): Promise<Output> {
    const type = this.typeOf(action);
    if (!type) {
      return run();
    }
    const [before, after] = LIFECYCLES[type];
    const name = this.nameOf(input);
    const event = { type, client, action, ...(name ? { name: `${name}` } : {}) };

    this.emitted.next({ ...event, lifecycle: before } as CdkEvent);
    try {
      const output = await run();
      this.emitted.next({ ...event, lifecycle: after } as CdkEvent);
      return output;
    } catch (error) {
      this.emitted.next({ ...event, lifecycle: 'failed' });
      throw error;
    }
  }

  /** Logs a finished command at info if it changes something, by name only. */
  protected changed(action: string, input: unknown): void {
    const type = this.typeOf(action);
    if (type && type !== 'describe' && type !== 'read') {
      const name = this.nameOf(input);
      this.log.info(`${action}${name ? `: ${name}` : ''}`);
    }
  }

  private typeOf(action: string): CdkEventType | undefined {
    const types = Object.entries(this.options.commands) as [CdkEventType, RegExp][];
    return types.find(([, pattern]) => pattern.test(action))?.[0];
  }

  // Names only: an input can carry the function's environment.
  private nameOf(input: unknown): unknown {
    const fields = new Map(Object.entries(input ?? {}).map(([field, value]) => [field.toLowerCase(), value]));
    return this.options.names.map((field) => fields.get(field)).find(Boolean);
  }
}
