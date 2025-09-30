import { ILoggable } from '../log';

export class ShellResponse implements ILoggable {
  repr(): string {
    throw new Error('Method not implemented.');
  }
}
