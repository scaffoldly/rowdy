import { isObservable } from 'rxjs';
import { methodName } from './name';
import { traced } from './operators';
import type { Run } from './run';
import { attributesOf, callHook } from './attributes';
import { redactorOf } from './redact';

type Fn = (this: unknown, ...args: unknown[]) => unknown;
type DecorateMethod = (value: Fn, context: Pick<ClassMethodDecoratorContext, 'name' | 'static'>) => Fn;

/**
 * Wraps a method of a traced class. An async method is traced as `@Trace` traces it, from its
 * call. Any other method is called as is, and only an Observable it returns is traced, a run for
 * each subscription; a plain value, or a Promise from a function that is not async, goes back as is.
 */
const wrap = (
  value: Fn,
  context: Pick<ClassMethodDecoratorContext, 'name' | 'static'>,
  decorate: DecorateMethod
): Fn =>
  value.constructor.name === 'AsyncFunction'
    ? decorate(value, context)
    : function (this: unknown, ...args: unknown[]): unknown {
        const returned = value.apply(this, args);
        if (!isObservable(returned)) return returned;
        const { hooks = [], parts } = attributesOf(value) ?? {};
        const annotate = hooks.length
          ? (run: Run): void => hooks.forEach((hook) => run.annotate(callHook(hook, this)))
          : undefined;
        return traced(methodName(this, context), { args, redactor: redactorOf(value), annotate, parts }, () => ({
          source: returned,
          attributes: () => ({}),
        }));
      };

const SKIPPED = new Set<PropertyKey>(['constructor', 'length', 'name', 'prototype']);

/** Wraps the methods `owner` defines itself: not getters or setters, or well-known symbols, or ones `traced` marks. */
const wrapAll = (owner: object, isStatic: boolean, traced: symbol, decorate: DecorateMethod): void => {
  for (const key of Reflect.ownKeys(owner)) {
    if (SKIPPED.has(key)) continue;
    if (typeof key === 'symbol' && key.description?.startsWith('Symbol.')) continue;
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
    const value = descriptor.value as Fn | undefined;
    if (typeof value !== 'function' || (value as unknown as Record<symbol, unknown>)[traced] || !descriptor.writable)
      continue;
    // A class held by a static property is not a method.
    if (/^class[\s{]/.test(Function.prototype.toString.call(value))) continue;
    Object.defineProperty(owner, key, {
      ...descriptor,
      value: wrap(value, { name: key as string | symbol, static: isStatic }, decorate),
    });
  }
};

/** `@Trace` on a class: its own methods, instance and static, each as `wrap` traces it. */
export const traceClass = (value: { prototype: object }, traced: symbol, decorate: DecorateMethod): void => {
  wrapAll(value.prototype, false, traced, decorate);
  wrapAll(value, true, traced, decorate);
};
