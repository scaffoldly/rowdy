import { Logger } from './log';

/** What a command does to what it names. */
export type CommandType = 'describe' | 'read' | 'create' | 'update' | 'dispose' | 'tag';

export type ClientLoggerOptions = {
  /** Which commands are which type, by name. The first match wins. A command with no match isn't logged. */
  commands: Partial<Record<CommandType, RegExp>>;
  /** The fields that name what a command is about, most specific first, in lower case. */
  names: string[];
};

/** Logs what a cloud SDK's client does. A subclass wires `changed` into its SDK. */
export abstract class ClientLogger {
  constructor(private options: ClientLoggerOptions) {}

  abstract get log(): Logger;

  /** Logs a finished command at info if it changes something, by name only. */
  protected changed(action: string, input: unknown): void {
    const type = this.typeOf(action);
    if (type && type !== 'describe' && type !== 'read') {
      const name = this.nameOf(input);
      this.log.info(`${action}${name ? `: ${name}` : ''}`);
    }
  }

  private typeOf(action: string): CommandType | undefined {
    const types = Object.entries(this.options.commands) as [CommandType, RegExp][];
    return types.find(([, pattern]) => pattern.test(action))?.[0];
  }

  // Names only: an input can carry the function's environment.
  private nameOf(input: unknown): unknown {
    const fields = new Map(Object.entries(input ?? {}).map(([field, value]) => [field.toLowerCase(), value]));
    return this.options.names.map((field) => fields.get(field)).find(Boolean);
  }
}
