import type { AttributeValue, Span } from '@opentelemetry/api';
import { EMPTY, from, Observable, of, type Subscribable, type Unsubscribable } from 'rxjs';
import type { Tracker } from './tracker';

/**
 * An attribute as a hook gives it: known now, when a Promise resolves, or on each emission of a
 * Subject, or a Subject's asObservable(). Any other Observable is never subscribed and sets nothing.
 */
export type AttributeInput =
  | AttributeValue
  | undefined
  | PromiseLike<AttributeValue | undefined>
  | Observable<AttributeValue | undefined>;

type Hook = (this: unknown, self: unknown) => Record<string, AttributeInput> | undefined;

// What `args` and `result` give, as the instance form does: each value followed the same way.
type Plain = Record<string, AttributeInput> | undefined;

/** `@Attributes({ args, result })`: from a call's arguments, and from what it returns, resolves to or emits. */
export interface AttributeParts {
  args?: (...args: never[]) => Plain;
  result?: (value: never) => Plain;
}

/** What `@Attributes` set on a method: hooks of the instance, and parts of the call. */
export interface MethodAttributes {
  hooks: Hook[];
  parts: AttributeParts[];
}

const ATTRIBUTES = new WeakMap<object, MethodAttributes>();

/** What `@Attributes` set on any of `methods`, the method as written or a wrapper of it, together. */
export const attributesOf = (...methods: object[]): MethodAttributes | undefined => {
  const found = methods.flatMap((method) => ATTRIBUTES.get(method) ?? []);
  if (!found.length) return undefined;
  return { hooks: found.flatMap(({ hooks }) => hooks), parts: found.flatMap(({ parts }) => parts) };
};

/** What a part gives for its arguments; nothing when it throws. */
const callPart = (part: (...args: unknown[]) => Plain, args: unknown[]): Plain => {
  try {
    const values = part(...args);
    return values && typeof values === 'object' ? values : undefined;
  } catch {
    return undefined;
  }
};

/** Sets each part's `args` attributes for a call's `args`. */
export const annotateArgs = (parts: AttributeParts[], args: unknown[], annotate: (values: Plain) => void): void =>
  parts.forEach(({ args: of }) => of && annotate(callPart(of as (...args: unknown[]) => Plain, args)));

/**
 * Sets each part's `result` attributes as a run's result is known: the value a call returns or its
 * Promise resolves to, or each emission of an Observable's run. First among a run's trackers, so the
 * span is still open.
 */
export const resultTracker = (parts: AttributeParts[], annotate: (values: Plain) => void): Tracker => {
  const results = parts.flatMap(({ result }) => (result ? [result as (value: unknown) => Plain] : []));
  const set = (value: unknown): void => results.forEach((result) => annotate(callPart(result, [value])));
  return {
    subscribe: () => undefined,
    emit: set,
    // An Observable's run completes with no value.
    complete: (...value) => (value.length ? set(value[0]) : undefined),
    fail: () => undefined,
    unsubscribe: () => undefined,
    returned: () => undefined,
  };
};

/** What a hook gives for `self`, the instance or, for a static method, the class; nothing when it throws. */
export const callHook = (hook: Hook, self: unknown): Record<string, AttributeInput> | undefined => {
  try {
    const values = hook.call(self, self);
    return values && typeof values === 'object' ? values : undefined;
  } catch {
    return undefined;
  }
};

const isAttributeValue = (value: unknown): value is AttributeValue => {
  const scalar = (v: unknown): boolean =>
    v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);
  if (Array.isArray(value)) return value.every(scalar);
  return value !== null && value !== undefined && scalar(value);
};

/** What a span gives `follow`: whether it is open, what to hold its end for, what to stop at its end. */
export interface Annotated {
  readonly span: Span;
  isOpen(): boolean;
  /** Holds the span's end until the returned release is called. */
  hold(): () => void;
  own(subscription: Unsubscribable): void;
}

type Piped = { source?: unknown; operator?: unknown };

// A Subject by its shape, so one from another copy of rxjs counts. A piped Subject is one too, with an operator.
const isSubject = (value: unknown): boolean => {
  const subject = value as Partial<{ next: unknown; subscribe: unknown; observers: unknown }> & Piped;
  return (
    typeof subject?.next === 'function' &&
    typeof subject.subscribe === 'function' &&
    Array.isArray(subject.observers) &&
    !subject.operator
  );
};

/**
 * Whether subscribing to `value` only listens: a Subject, or a Subject's asObservable(). Anything
 * else may do work on each subscription, which no Observable says, so it is never subscribed.
 */
const isHot = (value: Piped): boolean => isSubject(value) || (!value.operator && isSubject(value.source));

/** Any input as an Observable: a value of one emission, a Promise's value, or a hot Observable itself. */
const observe = (value: AttributeInput): Observable<unknown> => {
  const subscribable = value as (Partial<{ subscribe: unknown }> & Piped) | undefined;
  if (typeof subscribable?.subscribe === 'function') {
    return isHot(subscribable) ? (subscribable as Observable<unknown>) : EMPTY;
  }
  if (typeof (value as Partial<PromiseLike<unknown>> | undefined)?.then === 'function') {
    return from(value as PromiseLike<unknown>);
  }
  return of(value);
};

/**
 * Sets each of `values` on the span on each emission, while the span is open. One that has not
 * completed when the span ends holds the end, and is unsubscribed at it.
 */
export const follow = ({ span, isOpen, hold, own }: Annotated, values: Record<string, AttributeInput>): void => {
  const set = (key: string, value: unknown): void => {
    if (isOpen() && isAttributeValue(value)) span.setAttribute(key, value);
  };
  for (const [key, value] of Object.entries(values)) {
    let release: (() => void) | undefined;
    let done = false;
    const end = (): void => {
      done = true;
      release?.();
    };
    // A rejection, or an error, sets nothing.
    const subscription = observe(value).subscribe({
      next: (emitted) => set(key, emitted),
      error: end,
      complete: end,
    });
    if (done) continue;
    release = hold();
    own(subscription);
  }
};

type Method<This, Args extends unknown[], R> = (this: This, ...args: Args) => R;

// On a @Trace wrapper, the method it wraps.
const WRAPPED = Symbol.for('@scaffoldly/rowdy-cdk/trace.traced');

/** Records `entry` for `method`, one per method: a second, on it or across a @Trace of it, throws. */
const add = (method: object, entry: MethodAttributes, name: string | symbol): void => {
  const wrapped = (method as Record<symbol, unknown>)[WRAPPED];
  if (ATTRIBUTES.has(method) || (typeof wrapped === 'function' && ATTRIBUTES.has(wrapped))) {
    throw new TypeError(`@Attributes is once per method: ${String(name)}`);
  }
  ATTRIBUTES.set(method, entry);
};

/** What `@Attributes` takes, all of it for one method: from the instance, the arguments and the result. */
export interface AttributesOf<This, Args extends unknown[], V> {
  /**
   * From the instance, or for a static method the class, given as its argument and as `this`,
   * called once a call returns, or as each subscription of an Observable method starts. Its type
   * is not inferred from the method: give it, `(self: Sandbox) => …`.
   */
  self?: (this: This, self: This) => Record<string, AttributeInput> | undefined;
  /** From each call's arguments, as each of its runs starts. */
  args?: (...args: Args) => Record<string, AttributeInput> | undefined;
  /**
   * From what a call returns, what its Promise or thenable resolves to, or each emission of an
   * Observable's traced run, never subscribed again, the last winning.
   */
  result?: (value: V) => Record<string, AttributeInput> | undefined;
}

/**
 * Attributes on each traced call's span, one `@Attributes` per method, under `@Trace` on the method
 * or its class, in either order: `self`, `args` and `result`, any of them, each giving attributes.
 *
 * Each value is a primitive, a Promise or thenable, or a Subject (or its asObservable()), state that
 * subscribing only listens to, and set as it is known: at once, when it resolves, or on each
 * emission, the last winning. Any other Observable, which may do work on each subscription, is
 * never subscribed. A value is set only while the span is open; one that comes after is dropped,
 * and a span with one not yet complete ends once the current microtasks drain, as of when its call
 * ended. A function that throws, undefined, an Error or a rejection sets nothing, and the call goes
 * on.
 */
export const Attributes =
  <This = unknown, V = unknown, Args extends unknown[] = never[]>({
    self,
    args,
    result,
  }: AttributesOf<This, Args, V>) =>
  <T extends This, A extends unknown[], R extends V | PromiseLike<V> | Subscribable<V>>(
    value: Method<T, A, R>,
    context: ClassMethodDecoratorContext<T, Method<T, A, R>>
  ): Method<T, A, R> => {
    add(
      value,
      {
        hooks: self ? [self as Hook] : [],
        parts: args || result ? [{ args, result } as AttributeParts] : [],
      },
      context.name
    );
    return value;
  };
