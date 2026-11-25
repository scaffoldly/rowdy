import type { Subscribable } from 'rxjs';

/** What `@Trace` logs of a call in place of its arguments and its result. */
export interface Redactor {
  args?: (...args: never[]) => unknown[];
  result?: (value: never) => unknown;
}

const REDACTORS = new WeakMap<object, Redactor>();

const FAILED = '[redaction failed]';

/** The redactor `@Redact` set on any of `methods`: the method as written, or a wrapper of it. */
export const redactorOf = (...methods: object[]): Redactor | undefined =>
  methods.map((method) => REDACTORS.get(method)).find(Boolean);

/** What to log of a call's arguments; with a redactor that throws, or returns no array, only that it failed. */
export const redactArgs = (redactor: Redactor | undefined, args: unknown[]): unknown[] => {
  if (!redactor?.args) return args;
  try {
    const redacted = (redactor.args as (...args: unknown[]) => unknown)(...args);
    return Array.isArray(redacted) ? redacted : [FAILED];
  } catch {
    return [FAILED];
  }
};

/** What to log of a call's result, or one emission; with a redactor that throws, only that it failed. */
export const redactResult = (redactor: Redactor | undefined, value: unknown): unknown => {
  if (!redactor?.result) return value;
  try {
    return (redactor.result as (value: unknown) => unknown)(value);
  } catch {
    return FAILED;
  }
};

type Method<This, Args extends unknown[], R> = (this: This, ...args: Args) => R;

/**
 * What `@Trace`, on the method or its class, logs and records of a call: `result` in place of what
 * it returns, a Promise's value or each emission of an Observable, and `args` in place of its
 * arguments. A function is `result` alone. The caller still gets the real value; a redactor that
 * throws is logged as `[redaction failed]`, never the value. In either order with `@Trace`.
 */
export const Redact =
  <V = unknown, Args extends unknown[] = never[]>(
    redactor: ((value: V) => unknown) | { args?: (...args: Args) => unknown[]; result?: (value: V) => unknown }
  ) =>
  <This, A extends unknown[], R extends V | PromiseLike<V> | Subscribable<V>>(
    value: Method<This, A, R>,
    _context: ClassMethodDecoratorContext<This, Method<This, A, R>>
  ): Method<This, A, R> => {
    REDACTORS.set(value, (typeof redactor === 'function' ? { result: redactor } : redactor) as Redactor);
    return value;
  };
