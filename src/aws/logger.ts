import { Logger as ClientLogger } from '@smithy/types';
import { inspect } from 'util';
import { Logger, maskJson } from '../log';

const CHANGES = /^(Create|Update|Delete|Put|Publish|Add|Remove|Run|Terminate)/;

// The fields that name what a command changes, most specific first.
const NAMES = ['FunctionName', 'RoleName', 'Name', 'name', 'microvmIdentifier', 'imageIdentifier', 'Key', 'Bucket'];

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
      if (CHANGES.test(`${commandName}`) && !`${commandName}`.includes('AuthToken')) {
        // Names only: an input can carry the function's environment.
        const fields = (input ?? {}) as Record<string, unknown>;
        const name = NAMES.map((field) => fields[field]).find(Boolean);
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
