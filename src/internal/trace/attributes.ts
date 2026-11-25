import type { AttributeValue, Span } from '@opentelemetry/api';
import { from, isObservable, Observable, of, type Subscribable, type Unsubscribable } from 'rxjs';

/** An attribute as a hook gives it: known now, when a Promise resolves, or on each emission. */
export type AttributeInput =
  | AttributeValue
  | undefined
  | PromiseLike<AttributeValue | undefined>
  | Subscribable<AttributeValue | undefined>;

/** A call, as a hook sees it: an Observable method's `result` is the emissions of its own run. */
export type AttributeCall<Args extends unknown[], R> = { args: Args; result: R };

type Hook = (this: unknown, call: AttributeCall<unknown[], unknown>) => Record<string, AttributeInput> | undefined;

const HOOKS = new WeakMap<object, Hook>();

/** The hook `@Attributes` set on any of `methods`: the method as written, or a wrapper of it. */
export const attributesOf = (...methods: object[]): Hook | undefined =>
  methods.map((method) => HOOKS.get(method)).find(Boolean);

/** What a hook gives for a call, or nothing when it throws. */
export const callHook = (
  hook: Hook,
  self: unknown,
  call: AttributeCall<unknown[], unknown>
): Record<string, AttributeInput> | undefined => {
  try {
    const values = hook.call(self, call);
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

/** Any input as an Observable: a value of one emission, a Promise's value, or the Observable itself. */
const observe = (value: AttributeInput): Observable<unknown> => {
  if (isObservable(value)) return value;
  const subscribable = value as Partial<Subscribable<unknown>> | undefined;
  if (typeof subscribable?.subscribe === 'function') {
    return new Observable((subscriber) => subscribable.subscribe!(subscriber));
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
 * Attributes on each traced call's span, from `hook`, called with the call's `this`, its arguments
 * and its result: a method's value, the same Promise, or, for an Observable, the emissions of the
 * traced run, one hook call per subscription, never the method's Observable subscribed again.
 *
 * Each value is followed as an Observable, a plain value of one emission and a Promise of its value,
 * and set on each emission, the last winning, only while the span is open; one that comes after is
 * dropped. A span with an attribute not yet complete ends once the current microtasks drain, as of
 * when its call ended.
 * undefined, an Error, a rejection, or a hook that throws sets nothing. Under `@Trace` on the method
 * or its class, in either order.
 */
export const Attributes =
  <This, Args extends unknown[], R>(
    hook: (this: This, call: AttributeCall<Args, R>) => Record<string, AttributeInput> | undefined
  ) =>
  <T extends This>(
    value: Method<T, Args, R>,
    _context: ClassMethodDecoratorContext<T, Method<T, Args, R>>
  ): Method<T, Args, R> => {
    HOOKS.set(value, hook as Hook);
    return value;
  };
