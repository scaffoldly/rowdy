import { Logger as ClientLogger } from '@smithy/types';
import { inspect } from 'util';
import { Logger, maskJson } from '../log';

/** Logs what an AWS SDK client does: a change at info, by name only, and everything at debug. */
export abstract class AwsClientLogger implements ClientLogger {
  abstract get log(): Logger;

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
      if (/^(Create|Update|Delete|Put|Publish|Add|Remove)/.test(`${commandName}`)) {
        // Names only: an input can carry the function's environment.
        const { FunctionName, RoleName, Name, Key, Bucket } = (input ?? {}) as Record<string, unknown>;
        const name = FunctionName ?? RoleName ?? Name ?? Key ?? Bucket;
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
