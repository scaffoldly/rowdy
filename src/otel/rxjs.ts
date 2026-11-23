import { context, type Context } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  isWrapped,
  type InstrumentationConfig,
} from '@opentelemetry/instrumentation';
import * as rxjs from 'rxjs';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version';

type RxJS = typeof rxjs;
type Subscribe = (this: rxjs.Observable<unknown>, ...args: unknown[]) => rxjs.Subscription;
type Method = (this: Tagged, ...args: unknown[]) => void;
type Tagged = rxjs.Subscriber<unknown> & { [CONTEXT]?: Context };

// Symbol.for: each bundle of this module must read the tag another wrote.
const CONTEXT = Symbol.for('@scaffoldly/rowdy-cdk/otel/rxjs.context');
const METHODS = ['next', 'error', 'complete', 'unsubscribe'] as const;

const tag = (subscriber: Tagged, ctx: Context): void => {
  if (subscriber[CONTEXT] === undefined) {
    Object.defineProperty(subscriber, CONTEXT, { value: ctx });
  }
};

const patchSubscribe =
  (subscriberClass: RxJS['Subscriber']) =>
  (original: Subscribe): Subscribe =>
    function (this: rxjs.Observable<unknown>, ...args: unknown[]): rxjs.Subscription {
      const ctx = context.active();
      // Operators subscribe to their source with a Subscriber of their own.
      for (const arg of args) {
        if (arg instanceof subscriberClass) tag(arg, ctx);
      }
      const subscription = original.apply(this, args);
      // The Subscriber rxjs made around the callbacks passed in.
      if (subscription instanceof subscriberClass) tag(subscription, ctx);
      return subscription;
    };

const patchMethod = (original: Method): Method =>
  function (this: Tagged, ...args: unknown[]): void {
    const ctx = this[CONTEXT];
    if (ctx === undefined || ctx === context.active()) return original.apply(this, args);
    return context.with(ctx, original, this, ...args);
  };

/**
 * Runs every subscriber, operators' included, in the context active when it subscribed:
 * `next`, `error`, `complete` and `unsubscribe` (so `finalize` and other teardowns too).
 * Patches the rxjs this module imports on `enable()`, so rxjs already loaded, imported as ESM,
 * or bundled with this package is covered; other copies are patched when required.
 */
export class RxJSInstrumentation extends InstrumentationBase<InstrumentationConfig> {
  constructor(config: InstrumentationConfig = {}) {
    super(PACKAGE_NAME, PACKAGE_VERSION, config);
  }

  override enable(): void {
    super.enable();
    this._patch(rxjs);
  }

  override disable(): void {
    super.disable();
    this._unpatch(rxjs);
  }

  protected init(): InstrumentationNodeModuleDefinition[] {
    return [
      new InstrumentationNodeModuleDefinition(
        'rxjs',
        ['>=7'],
        (rx: RxJS) => this._patch(rx),
        (rx?: RxJS) => this._unpatch(rx)
      ),
    ];
  }

  private _patch(rx: RxJS): RxJS {
    this._unpatch(rx);
    this._wrap(rx.Observable.prototype, 'subscribe', patchSubscribe(rx.Subscriber) as never);
    this._massWrap([rx.Subscriber.prototype], [...METHODS], patchMethod as never);
    return rx;
  }

  private _unpatch(rx?: RxJS): void {
    if (rx === undefined) return;
    if (isWrapped(rx.Observable.prototype.subscribe)) {
      this._unwrap(rx.Observable.prototype, 'subscribe');
    }
    for (const name of METHODS) {
      if (isWrapped(rx.Subscriber.prototype[name])) {
        this._unwrap(rx.Subscriber.prototype, name);
      }
    }
  }
}
