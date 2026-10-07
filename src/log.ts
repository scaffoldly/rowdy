import { defer, finalize, isObservable, Observable, tap } from 'rxjs';

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

const SENSITIVE = /secret|token|password|passwd|credential|authorization|cookie/i;

/**
 * A sensitive string as it may be logged: its length and a short prefix and suffix. At most 4
 * characters per end and never more than a quarter of the string; under 8 characters, none.
 */
export const mask = (value: unknown): string => {
  const s = typeof value === 'string' ? value : String(value ?? '');
  const keep = Math.min(4, Math.floor(s.length / 8));
  return `${s.slice(0, keep)}…${keep ? s.slice(-keep) : ''} (${s.length} chars)`;
};

/** An environment as it may be logged, `[NAME=value, …]`: every name, every value masked. */
export const maskEnv = (env: Record<string, unknown> = {}): string =>
  `[${Object.entries(env)
    .map(([name, value]) => `${name}=${mask(value)}`)
    .join(', ')}]`;

const masked = (value: unknown, key = ''): unknown => {
  if (typeof value === 'string') {
    return SENSITIVE.test(key) ? mask(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => masked(v, key));
  }
  if (value && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON !== 'function') {
    const env = key === 'Variables';
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, env ? mask(v) : masked(v, k)]));
  }
  return value;
};

/** JSON of an arbitrary structure with `Variables` maps and credential-named strings masked. */
export const maskJson = (value: unknown): string => JSON.stringify(masked(value));

// Header and query-parameter names whose values are credentials. Wider than SENSITIVE: `auth`
// would also hit harmless structure keys such as Lambda's `AuthType`. Short names match only as
// whole words, so `encoded`, `keyword`, `design` and `postcode` stay readable.
const SENSITIVE_NAME = new RegExp(
  [
    'auth|cookie|secret|token|passw|passcode|passphrase|credential|session|signature|jwt|bearer|assertion|private',
    'key($|[-_.])',
    '(^|[-_.])(code|sig|otp|pin|nonce)($|[-_.])',
  ].join('|'),
  'i'
);

/** A query string as it may be logged: every name, sensitive-named values masked. */
export const maskQuery = (search: string | URLSearchParams = ''): string =>
  [...new URLSearchParams(search)]
    .map(([name, value]) => `${name}=${SENSITIVE_NAME.test(name) ? mask(value) : value}`)
    .join('&');

/** A URL as it may be logged: password and sensitive-named query values masked. */
export const maskUrl = (url: string | { toString(): string }): string => {
  let parsed;
  try {
    // eslint-disable-next-line no-restricted-globals -- URI (routes.ts) depends on this module
    parsed = new URL(String(url));
  } catch {
    return String(url);
  }
  if (!parsed.host) {
    return String(url); // opaque (data:, file:): nothing to mask by name
  }
  const auth = parsed.username ? `${parsed.username}${parsed.password ? `:${mask(parsed.password)}` : ''}@` : '';
  const query = maskQuery(parsed.searchParams);
  return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}${query ? `?${query}` : ''}${parsed.hash}`;
};

/** Headers as they may be logged, `name=value, …`: every name, credential values masked. */
export const maskHeaders = (headers: Record<string, unknown> = {}): string =>
  Object.entries(headers)
    .map(([name, value]) => {
      const values = (Array.isArray(value) ? value : [value]).map((v) => String(v ?? ''));
      const shown = SENSITIVE_NAME.test(name)
        ? values.map(mask)
        : values.map((v) => (/^https?:\/\//.test(v) ? maskUrl(v) : v));
      return `${name}=${shown.join(',')}`;
    })
    .join(', ');

export type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type Format = 'text' | 'json';

const LEVELS: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

export const isLevel = (value: unknown): value is Level => typeof value === 'string' && value in LEVELS;

// Process-wide: every Logger, children included, shares one level, format and context.
const state: { level?: Level; format?: Format; context: Record<string, Primitive> } = { context: {} };

const envLevel = (): Level => {
  const explicit = process.env.ROWDY_LOG_LEVEL?.toLowerCase();
  if (isLevel(explicit)) {
    return explicit;
  }
  if (process.env.ROWDY_TRACE === 'true') {
    return 'trace';
  }
  if (process.env.ROWDY_DEBUG === 'true') {
    return 'debug';
  }
  return 'info';
};

const envFormat = (): Format => (process.env.ROWDY_LOG_FORMAT?.toLowerCase() === 'json' ? 'json' : 'text');

// One event per line: the log collector splits on newlines.
const oneLine = (value: string): string => value.replace(/\r?\n\s*/g, ' \\n ');

// The text format follows the Lambda platform's own lines (`START RequestId: … Version: 47`):
// `LEVEL RequestId: <id> Component Message Key: value …`. Human-oriented; use json for parsing.
const capital = (word: string): string => (word ? word[0]!.toUpperCase() + word.slice(1) : word);

// Plain-word messages are title-cased; anything with punctuation or identifiers is left as written.
const title = (message: string): string =>
  /^[A-Za-z][A-Za-z ]*$/.test(message) ? message.replace(/\b[a-z]+\b/g, capital) : oneLine(message);

const field = (key: string, value: Primitive): string => {
  const text =
    value instanceof Error
      ? value.name === 'Error'
        ? value.message
        : `${value.name}: ${value.message}`
      : String(value);
  return `${capital(key)}: ${oneLine(text) || '""'}`;
};

export class Logger {
  private static children = new Map<string, Logger>();

  constructor(public readonly component?: string) {}

  /** A logger whose lines carry `component`. Shares level, format and context with every other. */
  child(component: string): Logger {
    let child = Logger.children.get(component);
    if (!child) {
      child = new Logger(component);
      Logger.children.set(component, child);
    }
    return child;
  }

  /**
   * Fields stamped on every line until unbound. `requestId` is the invocation being served and
   * leads the line, as it does on the platform's START / END / REPORT.
   */
  static bind(fields: Record<string, Primitive>): void {
    Object.assign(state.context, fields);
  }

  static unbind(...keys: string[]): void {
    for (const key of keys) {
      delete state.context[key];
    }
  }

  get level(): Level {
    return state.level ?? envLevel();
  }

  get format(): Format {
    return state.format ?? envFormat();
  }

  enabled(level: Level): boolean {
    return LEVELS[level] <= LEVELS[this.level];
  }

  get isDebugging(): boolean {
    return this.enabled('debug');
  }

  get isTracing(): boolean {
    return this.enabled('trace');
  }

  withLevel(level: Level | undefined): this {
    state.level = level;
    return this;
  }

  withFormat(format: Format | undefined): this {
    state.format = format;
    return this;
  }

  withDebugging(): this {
    return this.enabled('debug') ? this : this.withLevel('debug');
  }

  withTracing(): this {
    return this.withLevel('trace');
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

  private log = (level: Level, message: string, params: Loggable | Record<string, Loggable>): void => {
    if (!this.enabled(level)) {
      return;
    }

    const sink = level === 'trace' ? 'debug' : level;

    try {
      // A stack is debugging detail: below debug an error is its name and message.
      const primitive = (value: Loggable): Primitive =>
        value instanceof Error && !this.enabled('debug') ? value : Logger.asPrimitive(value);
      const fields: Record<string, Primitive> = isLoggable(params)
        ? { value: primitive(params) }
        : Object.fromEntries(Object.entries(params).map(([key, value]) => [key, primitive(value)]));
      Object.assign(fields, state.context);

      if (this.format === 'json') {
        const line: Record<string, unknown> = { level, component: this.component, msg: message };
        for (const [key, value] of Object.entries(fields)) {
          line[key] = value instanceof Error ? `${value.name}: ${value.message}` : value;
        }
        // eslint-disable-next-line no-console
        return console[sink](JSON.stringify(line));
      }

      const { requestId, ...rest } = fields;
      const head = [
        level.toUpperCase(),
        ...(requestId === undefined ? [] : [`RequestId: ${String(requestId)}`]),
        ...(this.component ? [capital(this.component)] : []),
        title(message),
      ];
      const tail = Object.entries(rest).map(([key, value]) => field(key, value));
      // eslint-disable-next-line no-console
      return console[sink]([...head, ...tail].join(' '));
    } catch (error) {
      // eslint-disable-next-line no-console
      return console.error(`Unable to log`, { error, level, message });
    }
  };

  /**
   * A line of someone else's output (the command's stdout or stderr), relayed as written: never
   * filtered by level, never recased. A line that is already JSON is passed through untouched.
   */
  relay = (sink: 'info' | 'error', line: string): void => {
    if (!line.trim()) {
      return;
    }
    const text = line.replace(/\s+$/, '');
    if (/^\s*\{.*\}$/.test(text)) {
      // eslint-disable-next-line no-console
      return console[sink](text);
    }
    if (this.format === 'json') {
      // eslint-disable-next-line no-console
      return console[sink](JSON.stringify({ level: 'info', component: this.component, msg: text, ...state.context }));
    }
    const { requestId } = state.context;
    const head = [
      'INFO',
      ...(requestId === undefined ? [] : [`RequestId: ${String(requestId)}`]),
      ...(this.component ? [capital(this.component)] : []),
    ];
    // eslint-disable-next-line no-console
    return console[sink](`${head.join(' ')} ${text}`);
  };

  error = (message: string, params: Record<string, Loggable> = {}): void => this.log('error', message, params);

  warn = (message: string, params: Record<string, Loggable> = {}): void => this.log('warn', message, params);

  info = (message: string, params: Record<string, Loggable> = {}): void => this.log('info', message, params);

  debug = (message: string, params: Loggable | Record<string, Loggable> = {}): void =>
    this.log('debug', message, params);

  trace = (message: string, params: Loggable | Record<string, Loggable> = {}): void =>
    this.log('trace', message, params);
}

export const log = new Logger();

const ms = (since: number): string => `${(performance.now() - since).toFixed(2)} ms`;

/**
 * Traces a method that returns an Observable, on `logger` at trace level: one line when it is
 * called (with its arguments), then one per emission, and one when the subscription ends, with
 * the time since it was subscribed. Nothing is wrapped below trace.
 *
 *     TRACE RequestId: … Lambda LambdaResponse.into Called
 *     TRACE RequestId: … Lambda LambdaResponse.into Emitted Duration: 2.12 ms Value: Result(…)
 *     TRACE RequestId: … Lambda LambdaResponse.into Completed Duration: 2.15 ms Emissions: 1
 *
 * A subscription that ends with an error logs `Failed` with the error; one that is unsubscribed
 * first (the loser of a `race`, an aborted request) logs `Unsubscribed`.
 */
export function Trace<This, Args extends ILoggable[], T extends Loggable>(
  logger: Logger = log
): (
  value: (this: This, ...args: Args) => Observable<T>,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Observable<T>>
) => (this: This, ...args: Args) => Observable<T> {
  return (value, context) => {
    const name = String(context.name);

    return function (this: This, ...args: Args): Observable<T> {
      if (!logger.isTracing) {
        return value.apply(this, args);
      }

      for (const a of args) {
        if (!isLoggable(a)) {
          throw new TypeError(`@Trace ${name}: argument is not Loggable`);
        }
      }

      // The decorator output aliases a class that references itself statically as `_Name`.
      const owner = (this as { constructor?: { name?: string } } | undefined)?.constructor?.name?.replace(/^_+/, '');
      const method = owner ? `${owner}.${name}` : name;

      logger.trace(`${method} Called`, args.length ? { args } : {});

      const result: unknown = value.apply(this, args);
      if (!isObservable(result)) {
        throw new TypeError(`@Trace ${name}: expected Observable<Loggable>`);
      }

      return defer(() => {
        const subscribed = performance.now();
        let emissions = 0;
        let settled = false;
        return (result as Observable<T>).pipe(
          tap({
            next: (emission: T): void => {
              if (!isLoggable(emission)) {
                throw new TypeError(`@Trace ${name}: emission is not Loggable`);
              }
              emissions += 1;
              logger.trace(`${method} Emitted`, { duration: ms(subscribed), value: emission });
            },
            error: (error: unknown): void => {
              settled = true;
              logger.trace(`${method} Failed`, {
                duration: ms(subscribed),
                emissions,
                error: error instanceof Error ? error : String(error),
              });
            },
            complete: (): void => {
              settled = true;
              logger.trace(`${method} Completed`, { duration: ms(subscribed), emissions });
            },
          }),
          finalize((): void => {
            if (!settled) {
              logger.trace(`${method} Unsubscribed`, { duration: ms(subscribed), emissions });
            }
          })
        );
      });
    };
  };
}
