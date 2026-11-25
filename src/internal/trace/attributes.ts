import type { AttributeValue, Span } from '@opentelemetry/api';
import { EMPTY, from, Observable, of, type Unsubscribable } from 'rxjs';

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

const HOOKS = new WeakMap<object, Hook>();

/** The hook `@Attributes` set on any of `methods`: the method as written, or a wrapper of it. */
export const attributesOf = (...methods: object[]): Hook | undefined =>
  methods.map((method) => HOOKS.get(method)).find(Boolean);

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

/**
 * Attributes on each traced call's span, from `hook`, given the instance, or for a static method the
 * class, as `this` and as its argument: `(self: Sandbox) => ({ 'rowdy.sandbox.name': self.name })`.
 * It is called once a call returns, or, for a method that returns an Observable, as each of its
 * subscriptions starts.
 *
 * Each value is a primitive, a Promise, or a Subject (or its asObservable()), state that subscribing
 * only listens to, followed as an Observable (a primitive of one emission, a Promise of its value)
 * and set on each emission, the last winning, only while the span is open; one that comes after is
 * dropped. Any other Observable, which may do work on each subscription, is never subscribed. A span with an attribute not yet complete ends
 * once the current microtasks drain, as of when its call ended, and stops following it.
 * undefined, an Error, a rejection, or a hook that throws sets nothing. Under `@Trace` on the method
 * or its class, in either order.
 */
export const Attributes =
  <This>(hook: (this: This, self: This) => Record<string, AttributeInput> | undefined) =>
  <T extends This, Args extends unknown[], R>(
    value: Method<T, Args, R>,
    _context: ClassMethodDecoratorContext<T, Method<T, Args, R>>
  ): Method<T, Args, R> => {
    HOOKS.set(value, hook as Hook);
    return value;
  };
