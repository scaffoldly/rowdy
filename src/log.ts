import { SeverityNumber, type LoggerProvider, type LogRecord, type Logger as OtelLogger } from '@opentelemetry/api';
import type { CdkOptions } from './cdk';

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

export const isLoggable = (v: unknown): v is Loggable =>
  isPrimitive(v) ||
  isArrayOfPrimitive(v) ||
  isILoggable(v) ||
  isArrayOfILoggable(v) ||
  v instanceof AbortSignal ||
  v instanceof Buffer;

// A key ending `key` after something else is one, like `API_KEY` or `apiKey`; a bare `Key`, like an
// S3 object's or a tag's, and an `accessKeyId` are not.
const SENSITIVE = /secret|token|password|passwd|passphrase|credential|authorization|cookie|private|.key($|[-_.])/i;

// Maps whose every value is masked, whatever its name: a secret's name says nothing about it.
// Case-sensitive: Lambda's `Environment` holds `Variables`, it is not one.
const ENV = /^(Variables|env|environment)$/;

/**
 * A sensitive string as it may be logged: its length and a short prefix and suffix. At most 4
 * characters per end and never more than a quarter of the string; under 8 characters, none.
 */
export const mask = (value: unknown): string => {
  const s = typeof value === 'string' ? value : String(value ?? '');
  const keep = Math.min(4, Math.floor(s.length / 8));
  return `${s.slice(0, keep)}…${keep ? s.slice(-keep) : ''} (${s.length} chars)`;
};

/** An environment as it may be logged, `[NAME=value, …]`: every name, every value masked except those named in `plain`. */
export const maskEnv = (env: Record<string, unknown> = {}, plain: ReadonlySet<string> = new Set()): string =>
  `[${Object.entries(env)
    .map(([name, value]) => `${name}=${plain.has(name) ? String(value ?? '') : mask(value)}`)
    .join(', ')}]`;

// Only arrays and plain objects are walked: anything else, like a response stream, can lead back to itself.
// Everything under a credential-named key is masked too, like a token kept under a name that says nothing.
const masked = (value: unknown, key = '', above: ReadonlySet<object> = new Set(), under = false): unknown => {
  const hidden = under || SENSITIVE.test(key);
  if (typeof value === 'string') {
    return hidden ? mask(value) : value;
  }
  if (!value || typeof value !== 'object' || typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return value;
  }
  if (above.has(value)) {
    return '[Circular]';
  }
  const within = new Set(above).add(value);
  if (Array.isArray(value)) {
    return value.map((v) => masked(v, key, within, hidden));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return `[${(value as object).constructor?.name || 'Object'}]`;
  }
  const env = ENV.test(key);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, env ? mask(v) : masked(v, k, within, hidden)]));
};

/** JSON of an arbitrary structure with `Variables`, `env` and `environment` maps and credential-named strings masked. */
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

/** An OpenTelemetry severity's level; FATAL is an error, and an unspecified one info. */
const levelOf = (severity: SeverityNumber | undefined): Level => {
  if (!severity) return 'info';
  if (severity >= SeverityNumber.ERROR) return 'error';
  if (severity >= SeverityNumber.WARN) return 'warn';
  if (severity >= SeverityNumber.INFO) return 'info';
  if (severity >= SeverityNumber.DEBUG) return 'debug';
  return 'trace';
};

/**
 * Where lines go. `'stderr'` sends every level to `console.error`. A console-like logger, such as pino, gets each
 * level's own method, with the line's fields first and its message second. A stream, such as `process.stderr`, is
 * written one formatted line at a time.
 */
// eslint-disable-next-line no-undef
export type Sink = 'stderr' | Pick<Console, 'error' | 'warn' | 'info' | 'debug'> | { write(line: string): unknown };

// Process-wide: every Logger, children included, shares one level, format, sink and context.
const state: { level?: Level; format?: Format; sink?: Sink; context: Record<string, Primitive> } = { context: {} };

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

export class Logger implements OtelLogger {
  private static children = new Map<string, Logger>();
  // A logger with a sink or level of its own keeps its children, so another's never write for it.
  private ownChildren = new Map<string, Logger>();

  /**
   * `own` is where this logger and its children write, in place of the process-wide sink. `ownLevel` is the level they
   * log at, in place of the process-wide one.
   */
  constructor(
    public readonly component?: string,
    private readonly own?: Sink,
    private readonly ownLevel?: Level
  ) {}

  /**
   * CdkOptions for the process-wide `log`: its children as the logger provider, so a traced call's
   * lines arrive as records under its logger's name, and the process-wide level, as it is now.
   */
  static defaults(): Pick<CdkOptions, 'loggerProvider' | 'logLevel'> {
    return { loggerProvider: DEFAULT_LOGGER_PROVIDER, logLevel: log.level };
  }

  /**
   * `provider`, its records below `level` dropped and its loggers' `enabled()` saying so; without a
   * `level`, the process-wide one, read at each record. The same one for the same provider and level.
   */
  static filter(provider: LoggerProvider, level?: Level): LoggerProvider {
    let byLevel = filters.get(provider);
    if (!byLevel) filters.set(provider, (byLevel = new Map()));
    let filtered = byLevel.get(level);
    if (!filtered) {
      const passes = (severity: SeverityNumber | undefined): boolean =>
        LEVELS[levelOf(severity)] <= LEVELS[level ?? log.level];
      filtered = {
        getLogger: (name, version, options): OtelLogger => {
          const logger = provider.getLogger(name, version, options);
          return {
            enabled: (of): boolean => (of?.severityNumber ? passes(of.severityNumber) : true) && logger.enabled(of),
            emit: (record): void => (passes(record.severityNumber) ? logger.emit(record) : undefined),
          };
        },
      };
      byLevel.set(level, filtered);
    }
    return filtered;
  }

  /** A logger provider of loggers that write where the process-wide `log` does, at `level`. */
  static at(level: Level): LoggerProvider {
    let provider = providers.get(level);
    if (!provider) {
      const loggers = new Map<string, Logger>();
      provider = {
        getLogger: (name: string): Logger => {
          let logger = loggers.get(name);
          if (!logger) loggers.set(name, (logger = new Logger(name, undefined, level)));
          return logger;
        },
      };
      providers.set(level, provider);
    }
    return provider;
  }

  /**
   * A logger whose lines carry `of` as their component: a string as given, a class by its name, and an instance by its
   * class's name, never by a `name` of its own. Shares format and context with every other, and its sink and level.
   */
  child(of: string | object): Logger {
    const component = typeof of === 'string' ? of : typeof of === 'function' ? of.name : of.constructor.name;
    const children = this.own || this.ownLevel ? this.ownChildren : Logger.children;
    let child = children.get(component);
    if (!child) {
      child = new Logger(component, this.own, this.ownLevel);
      children.set(component, child);
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
    return this.ownLevel ?? state.level ?? envLevel();
  }

  get format(): Format {
    return state.format ?? envFormat();
  }

  /**
   * Whether a line at `level`, or an OpenTelemetry record of `severityNumber`, is written. Without a
   * severity, whether any is: always, as errors always are.
   */
  enabled(level: Level): boolean;
  enabled(options?: { severityNumber?: SeverityNumber }): boolean;
  enabled(of?: Level | { severityNumber?: SeverityNumber }): boolean {
    const level = typeof of === 'string' ? of : of?.severityNumber ? levelOf(of.severityNumber) : 'error';
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

  /**
   * The process-wide sink, for every logger without one of its own: `'stderr'` for a host whose stdout is its own, a
   * console-like logger, or a stream. Undefined goes back to `console`, split by level.
   */
  withSink(sink: Sink | undefined): this {
    state.sink = sink;
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

    // A Logger of its own takes the call, under this one's component, at its own level too.
    if (this.own instanceof Logger) {
      return (this.component ? this.own.child(this.component) : this.own).log(level, message, params);
    }

    const method = level === 'trace' ? 'debug' : level;

    try {
      // A stack is debugging detail: below debug an error is its name and message.
      const primitive = (value: Loggable): Primitive =>
        value instanceof Error && !this.enabled('debug') ? value : Logger.asPrimitive(value);
      const fields: Record<string, Primitive> = isLoggable(params)
        ? { value: primitive(params) }
        : Object.fromEntries(Object.entries(params).map(([key, value]) => [key, primitive(value)]));
      Object.assign(fields, state.context);

      const sink = this.own ?? state.sink;
      if (sink && sink !== 'stderr' && !('write' in sink)) {
        const structured: Record<string, unknown> = { component: this.component };
        for (const [key, value] of Object.entries(fields)) {
          structured[key] = value instanceof Error ? `${value.name}: ${value.message}` : value;
        }
        return this.send(method, message, structured);
      }

      if (this.format === 'json') {
        const line: Record<string, unknown> = { level, component: this.component, msg: message };
        for (const [key, value] of Object.entries(fields)) {
          line[key] = value instanceof Error ? `${value.name}: ${value.message}` : value;
        }
        return this.send(method, JSON.stringify(line));
      }

      const { requestId, ...rest } = fields;
      const head = [
        level.toUpperCase(),
        ...(requestId === undefined ? [] : [`RequestId: ${String(requestId)}`]),
        ...(this.component ? [capital(this.component)] : []),
        title(message),
      ];
      const tail = Object.entries(rest).map(([key, value]) => field(key, value));
      return this.send(method, [...head, ...tail].join(' '));
    } catch (error) {
      // eslint-disable-next-line no-console
      return console.error(`Unable to log`, { error, level, message });
    }
  };

  /**
   * A line of someone else's output (the command's stdout or stderr), relayed as written: never
   * filtered by level, never recased. A line that is already JSON is passed through untouched.
   */
  relay = (stream: 'info' | 'error', line: string): void => {
    if (!line.trim()) {
      return;
    }
    if (this.own instanceof Logger) {
      return (this.component ? this.own.child(this.component) : this.own).relay(stream, line);
    }
    const text = line.replace(/\s+$/, '');
    const sink = this.own ?? state.sink;
    if (sink && sink !== 'stderr' && !('write' in sink)) {
      return this.send(stream, text, { component: this.component, ...state.context });
    }
    if (/^\s*\{.*\}$/.test(text)) {
      return this.send(stream, text);
    }
    if (this.format === 'json') {
      return this.send(
        stream,
        JSON.stringify({ level: 'info', component: this.component, msg: text, ...state.context })
      );
    }
    const { requestId } = state.context;
    const head = [
      'INFO',
      ...(requestId === undefined ? [] : [`RequestId: ${String(requestId)}`]),
      ...(this.component ? [capital(this.component)] : []),
    ];
    return this.send(stream, `${head.join(' ')} ${text}`);
  };

  /** One line to this logger's sink: a console-like one gets `fields` first when there are any. */
  // Not `write`: a sink with one is taken for a stream.
  private send(level: 'error' | 'warn' | 'info' | 'debug', text: string, fields?: Record<string, unknown>): void {
    const sink = this.own ?? state.sink;
    if (sink === 'stderr') {
      // eslint-disable-next-line no-console
      return console.error(text);
    }
    if (sink && 'write' in sink) {
      sink.write(`${text}\n`);
      return;
    }
    const target = sink ?? console;
    if (fields) {
      target[level](fields, text);
      return;
    }
    target[level](text);
  }

  error = (message: string, params: Record<string, Loggable> = {}): void => this.log('error', message, params);

  warn = (message: string, params: Record<string, Loggable> = {}): void => this.log('warn', message, params);

  info = (message: string, params: Record<string, Loggable> = {}): void => this.log('info', message, params);

  debug = (message: string, params: Loggable | Record<string, Loggable> = {}): void =>
    this.log('debug', message, params);

  trace = (message: string, params: Loggable | Record<string, Loggable> = {}): void =>
    this.log('trace', message, params);

  /**
   * An OpenTelemetry log record, as a line at its severity's level: its body the message (a string as
   * is, anything else as JSON, or else its event name), its attributes and exception the fields.
   */
  emit(record: LogRecord): void {
    const { body, eventName, attributes = {}, exception } = record;
    const message = typeof body === 'string' ? body : body === undefined ? (eventName ?? '') : JSON.stringify(body);
    const params: Record<string, Loggable> = {};
    for (const [key, value] of Object.entries(attributes)) {
      params[key] = isLoggable(value) ? value : JSON.stringify(value);
    }
    if (exception !== undefined) {
      params.error = exception instanceof Error ? exception : String(exception);
    }
    this.log(levelOf(record.severityNumber), message, params);
  }
}

export const log = new Logger();

// One object, so a provider handed over again is seen as the same one.
const DEFAULT_LOGGER_PROVIDER: LoggerProvider = { getLogger: (name: string) => log.child(name) };
const providers = new Map<Level, LoggerProvider>();
const filters = new WeakMap<LoggerProvider, Map<Level | undefined, LoggerProvider>>();
