export class Logger {
  // eslint-disable-next-line no-console
  warn = console.warn;
  // eslint-disable-next-line no-console
  log = console.log;
}

export const log = new Logger();
