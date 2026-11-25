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

type Plain = Record<string, AttributeValue | undefined> | undefined;

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
    const subscription = observe(value).subscribe({ next: (emitted) => set(key, emitted), error: end, complete: end });
    if (done) continue;
    release = hold();
    own(subscription);
  }
};

type Method<This, Args extends unknown[], R> = (this: This, ...args: Args) => R;

const add = (method: object, entry: Partial<MethodAttributes>): void => {
  const found = ATTRIBUTES.get(method) ?? { hooks: [], parts: [] };
  ATTRIBUTES.set(method, {
    hooks: [...found.hooks, ...(entry.hooks ?? [])],
    parts: [...found.parts, ...(entry.parts ?? [])],
  });
};

/**
 * Attributes on each traced call's span. Under `@Trace` on the method or its class, in either
 * order; any number on one method, of either form. A function that throws, undefined, an Error or a
 * rejection sets nothing, and the call goes on. Each value is set only while the span is open; one
 * that comes after is dropped.
 */
export const Attributes: {
  /**
   * `@Attributes((self) => ({ … }))`: from the instance, or for a static method the class, given as
   * `this` and as its argument, called once a call returns, or as each subscription of an Observable
   * method starts. Each value is a primitive, a Promise, or a Subject (or its asObservable()), state
   * that subscribing only listens to, set on each emission, the last winning. Any other Observable,
   * which may do work on each subscription, is never subscribed. A span with an attribute not yet
   * complete ends once the current microtasks drain, as of when its call ended.
   */
  <This>(
    hook: (this: This, self: This) => Record<string, AttributeInput> | undefined
  ): <T extends This, Args extends unknown[], R>(
    value: Method<T, Args, R>,
    context: ClassMethodDecoratorContext<T, Method<T, Args, R>>
  ) => Method<T, Args, R>;
  /**
   * `@Attributes({ args, result })`: `args` from each call's arguments, set at once; `result` from
   * what it returns, what its Promise or thenable resolves to, or each emission of an Observable's
   * traced run, never subscribed again, the last winning. Plain values: rowdy-cdk does the waiting.
   */
  <V = unknown, Args extends unknown[] = never[]>(parts: {
    args?: (...args: Args) => Plain;
    result?: (value: V) => Plain;
  }): <This, A extends unknown[], R extends V | PromiseLike<V> | Subscribable<V>>(
    value: Method<This, A, R>,
    context: ClassMethodDecoratorContext<This, Method<This, A, R>>
  ) => Method<This, A, R>;
} = ((given: Hook | AttributeParts) =>
  (value: object): object => {
    add(value, typeof given === 'function' ? { hooks: [given] } : { parts: [given] });
    return value;
  }) as never;
