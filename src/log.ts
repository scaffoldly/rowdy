import { isObservable, Observable, tap } from 'rxjs';

export interface ILoggable {
  repr(): string;
}

type Primitive = string | number | boolean | undefined | null | Error;

export type Loggable = Error | AbortSignal | Buffer | Primitive | Array<Primitive> | ILoggable | Array<ILoggable>;

const isPrimitive = (v: unknown): v is Primitive =>
  v === null ||
  v === undefined ||
  typeof v === 'string' ||
  typeof v === 'number' ||
  typeof v === 'boolean' ||
  v instanceof Error;

const isILoggable = (v: unknown): v is ILoggable =>
  typeof v === 'object' &&
  v !== null &&
  'repr' in (v as Record<string, unknown>) &&
  typeof (v as { repr?: unknown }).repr === 'function';

const isArrayOfPrimitive = (v: unknown): v is Primitive[] => Array.isArray(v) && v.every(isPrimitive);

const isArrayOfILoggable = (v: unknown): v is ILoggable[] => Array.isArray(v) && v.every(isILoggable);

const isLoggable = (v: unknown): v is Loggable =>
  isPrimitive(v) ||
  isArrayOfPrimitive(v) ||
  isILoggable(v) ||
  isArrayOfILoggable(v) ||
  v instanceof AbortSignal ||
  v instanceof Buffer;

export class Logger {
  private _debug = false;
  private _trace = false;

  constructor() {}

  get isDebugging(): boolean {
    return this._debug;
  }

  get isTracing(): boolean {
    return this._trace;
  }

  withDebugging(): this {
    this._debug = true;
    return this;
  }

  withTracing(): this {
    this._trace = true;
    return this;
  }

  static asPrimitive(value: Loggable): Primitive {
    try {
      if (value === undefined) {
        return '{undefined}';
      }

      if (value === null) {
        return '{null}';
      }

      if (Array.isArray(value)) {
        return `[${value.map((v) => Logger.asPrimitive(v)).join(',')}]`;
      }

      if (value && typeof value === 'object' && 'repr' in value && typeof value.repr === 'function') {
        return value.repr();
      }

      if (value instanceof AbortSignal) {
        const name = value.constructor?.name || 'AbortSignal';
        return `${name}(${value.aborted})`;
      }

      if (value instanceof Error) {
        const name = value.name || value.constructor?.name || 'Error';
        return `${name}: ${value.message}\n${value.stack?.split('\n').slice(1).join('\n\t')}`;
      }

      if (value instanceof Buffer) {
        return `Buffer(len=${value.length})`;
      }

      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
      }

      return new Error('Unable to convert value to primitive');
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Conversion Error`, { error, value });
      return `{unknown:${typeof value}}`;
    }
  }

  private log = (
    level: 'info' | 'error' | 'warn' | 'debug',
    message: string,
    params: Loggable | Record<string, Loggable>
  ): void => {
    if (level !== 'info') {
      message = `[${level.toUpperCase()}] ${message}`;
    }

    message = `[rowdy] ${message}`;

    if (isLoggable(params)) {
      // eslint-disable-next-line no-console
      return console[level](`${message} ${Logger.asPrimitive(params)}`);
    }

    try {
      params = Object.entries(params).reduce(
        (acc, [key, value]) => {
          acc[key] = Logger.asPrimitive(value);
          return acc;
        },
        {} as Record<string, Primitive>
      );

      if (Object.keys(params).length === 0) {
        // eslint-disable-next-line no-console
        return console[level](`${message}`);
      }

      // eslint-disable-next-line no-console
      return console[level](`${message}`, JSON.stringify(params));
    } catch (error) {
      // eslint-disable-next-line no-console
      return console.error(`Unable to log`, { error, level, message, params });
    }
  };

  info = (message: string, params: Record<string, Loggable> = {}): void => {
    return this.log('info', message, params);
  };

  error = (message: string, params: Record<string, Loggable> = {}): void => {
    return this.log('error', message, params);
  };

  warn = (message: string, params: Record<string, Loggable> = {}): void => {
    return this.log('warn', message, params);
  };

  debug = (message: string, params: Loggable | Record<string, Loggable> = {}): void => {
    if (!this.isDebugging) {
      return;
    }
    return this.log('debug', message, params);
  };
}

export const log = new Logger();

export function Trace<This, Args extends ILoggable[], T extends Loggable>(
  value: (this: This, ...args: Args) => Observable<T>,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Observable<T>>
): (this: This, ...args: Args) => Observable<T> {
  const name: string = String(context.name);

  const wrapped: (this: This, ...args: Args) => Observable<T> = function (this: This, ...args: Args): Observable<T> {
    if (!log.isTracing) {
      return value.apply(this, args);
    }

    for (const a of args) {
      if (!isLoggable(a)) {
        throw new TypeError(`@Trace ${name}: argument is not Loggable`);
      }
    }

    let thisName = name;
    if (this && typeof this === 'object' && 'constructor' in this && this.constructor) {
      thisName = `${this.constructor.name}.${name}`;
    }

    log.info('Trace.call', { method: thisName, args });

    const now = performance.now();
    const result: unknown = value.apply(this, args);
    if (!isObservable(result)) {
      throw new TypeError(`@Trace ${name}: expected Observable<Loggable>`);
    }

    return (result as Observable<T>).pipe(
      tap((emission: T): void => {
        if (!isLoggable(emission)) {
          throw new TypeError(`@Trace ${name}: emission is not Loggable`);
        }
        const duration = performance.now() - now;
        log.info(`Trace.emit (${duration.toFixed(2)}ms)`, { method: thisName, value: emission });
      })
    );
  };

  return wrapped;
}
