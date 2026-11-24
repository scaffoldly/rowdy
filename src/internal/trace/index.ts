import { context as otel } from '@opentelemetry/api';
import type { CdkOptions } from '../../cdk';
import { CdkInstrumentation } from '../../otel';
import { logCall } from './logging';
import { methodName } from './name';
import { RESULTS } from './results';
import { startRun, type Call } from './run';

type Method<This, Args extends unknown[], R> = (this: This, ...args: Args) => R;
type Decorator = <This, Args extends unknown[], R>(
  value: Method<This, Args, R>,
  context: ClassMethodDecoratorContext<This, Method<This, Args, R>>
) => Method<This, Args, R>;

/** A traced call's options, given to the one CdkInstrumentation before it runs. */
type OptionsOf = (self: unknown, args: unknown[]) => CdkOptions | undefined;

const decorate =
  (optionsOf?: OptionsOf): Decorator =>
  (value, context) =>
    function (this, ...args) {
      const method = methodName(this, context);
      // Its span, duration and lines go where the one CdkInstrumentation's do.
      const { options } = CdkInstrumentation.create(optionsOf?.(this, args) ?? {});

      const parent = otel.active();
      const call: Call = { parent, run: startRun(method, options, parent), again: () => startRun(method, options) };
      call.run.sinks.forEach((sink) => logCall(sink, method, args));

      let returned: unknown;
      try {
        returned = otel.with(call.run.context, () => value.apply(this, args));
      } catch (error) {
        call.run.tracker.fail(error);
        throw error;
      }

      const result = RESULTS.find((r) => r.matches(returned))!;
      return result.trace(returned as never, call) as ReturnType<typeof value>;
    };

const isDecoratorContext = (value: unknown): value is ClassMethodDecoratorContext =>
  typeof value === 'object' && value !== null && 'kind' in value && 'name' in value;

/**
 * Traces a method, instance or static, as `@Trace` or `@Trace(options)`, through the one
 * CdkInstrumentation: its span goes to that tracer provider, its duration (`cdk.trace.duration`)
 * to that meter provider, and its lines, as TRACE log records, to that logger provider, filtered at
 * its logLevel. Without a tracer or meter provider, no span or duration is recorded.
 *
 * A call is a span named for the method, `Owner.method`, a child of the span active at the call
 * and the parent of spans made during it. What the method returns decides when the span ends:
 * a value or a throw ends it with the call, and a Promise when it settles. An Observable's first
 * subscription carries the span on when it subscribes straight away, before the next microtask,
 * under the same active span; otherwise the span ends as `returned`, as of the call's return. Every
 * other subscription (a retry, a second subscriber, one made later) is a span of its own, under the
 * span active when it subscribes.
 *
 * The span ends with `cdk.trace.outcome` (`complete`, `error`, `unsubscribe` or `returned`), and
 * for an Observable `cdk.observable.emissions`; an error is also recorded on it, with an error
 * status and `error.type`.
 *
 * Its lines are the call with its arguments, each emission, and how it ended, with its duration:
 *
 *     TRACE @scaffoldly/rowdy-cdk LambdaResponse.into Called
 *     TRACE @scaffoldly/rowdy-cdk LambdaResponse.into Emitted Duration: 2.12 ms Value: Result(…)
 *     TRACE @scaffoldly/rowdy-cdk LambdaResponse.into Completed Duration: 2.15 ms Emissions: 1
 *
 * A failure is `Failed` with the error, a subscription unsubscribed first (the loser of a `race`,
 * an aborted request) `Unsubscribed`, and an Observable left for later `Returned`. Values that are
 * not Loggable are logged by their class name only.
 */
export const Trace: {
  /** `@Trace`. */
  <This, Args extends unknown[], R>(
    value: Method<This, Args, R>,
    context: ClassMethodDecoratorContext<This, Method<This, Args, R>>
  ): Method<This, Args, R>;
  /** `@Trace()`, the same. */
  (): Decorator;
  /**
   * `@Trace(options)`: `options` is called on every call, with its `this` and arguments, and what it
   * returns is given to CdkInstrumentation. `T extends This` lets a static method, whose `this` is
   * its class, take a function that ignores `this`.
   */
  <This, Args extends unknown[]>(
    options: (this: This, ...args: Args) => CdkOptions | undefined
  ): <T extends This, R>(
    value: Method<T, Args, R>,
    context: ClassMethodDecoratorContext<T, Method<T, Args, R>>
  ) => Method<T, Args, R>;
} = ((
  first?: Method<unknown, unknown[], unknown>,
  second?: ClassMethodDecoratorContext
): Decorator | Method<unknown, unknown[], unknown> => {
  if (isDecoratorContext(second)) return decorate()(first!, second);
  if (typeof first === 'function') {
    const options = first as (this: unknown, ...args: unknown[]) => CdkOptions | undefined;
    return decorate((self, args) => options.apply(self, args));
  }
  return decorate();
}) as never;
