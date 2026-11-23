import { inspect } from 'util';
import { ClientLogger } from './client';
import { maskJson } from './log';

const actionOf = (commandName: unknown): string => `${commandName}`.replace(/Command$/, '');

/** A `ClientLogger` for AWS SDK clients. Pass it as a client's `logger`. */
export abstract class SmithyClientLogger extends ClientLogger {
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
      if (this.log.enabled('debug')) {
        this.log.debug(`[${clientName ?? 'UnknownClient'}] [${commandName ?? 'UnknownCommand'}]`, {
          input: maskJson(input),
          output: maskJson(output),
        });
      }
      this.changed(actionOf(commandName), input);
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
      if (this.log.enabled('debug')) {
        this.log.debug(`[${clientName ?? 'UnknownClient'}] [${commandName ?? 'UnknownCommand'}]`, {
          input: maskJson(input),
          error: inspect(error),
        });
      }
      return;
    }
  };
}
