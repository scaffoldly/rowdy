import { context as otel } from '@opentelemetry/api';
import { log, Logger, type Level, type Sink } from '../../log';
import { logCall } from './logging';
import { methodName } from './name';
import { RESULTS } from './results';
import { startRun, type Call } from './run';

type Method<This, Args extends unknown[], R> = (this: This, ...args: Args) => R;
type Decorator = <This, Args extends unknown[], R>(
  value: Method<This, Args, R>,
  context: ClassMethodDecoratorContext<This, Method<This, Args, R>>
) => Method<This, Args, R>;

/** Options a call to a method traced as `@Trace(options)` carries. */
export interface CdkOptions {
  /** Where this call's trace lines go. Without one, a traced call makes spans and logs nothing. */
  logger?: Exclude<Sink, 'stderr'>;
  logLevel?: Level;
}

/** The logger one call logs on, or none. */
type LoggerOf = (self: unknown, args: unknown[]) => Logger | undefined;

const fromOptions =
  (options: (this: unknown, ...args: unknown[]) => CdkOptions | undefined): LoggerOf =>
  (self, args) => {
    // Never the process-wide log: a call without a logger of its own logs nothing.
    const { logger, logLevel } = options.apply(self, args) ?? {};
    return logger ? new Logger(undefined, logger, logLevel) : undefined;
  };

const decorate =
  (loggerOf: LoggerOf): Decorator =>
  (value, context) =>
    function (this, ...args) {
      const method = methodName(this, context);
      const logger = loggerOf(this, args);
      const logging = logger?.isTracing ? logger : undefined;
      if (logging) logCall(logging, method, args);

      const parent = otel.active();
      const call: Call = { parent, run: startRun(method, logging, parent), again: () => startRun(method, logging) };

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
 * Traces a method, instance or static, as `@Trace`, `@Trace(logger)` or `@Trace(options)`.
 *
 * A call is a span named for the method, `Owner.method`, a child of the span active at the call
 * and the parent of spans made during it. What the method returns decides when the span ends:
 * a value or a throw ends it with the call, and a Promise when it settles. An Observable's first
 * subscription carries the span on when it subscribes straight away, before the next microtask,
 * under the same active span; otherwise the span ends as `returned`, as of the call's return. Every
 * other subscription (a retry, a second subscriber, one made later) is a span of its own, under the
 * span active when it subscribes.
 *
 * The span ends with `rowdy.trace.outcome` (`complete`, `error`, `unsubscribe` or `returned`), and for an
 * Observable `rowdy.observable.emissions`; an error is also recorded on it, with an error status
 * and `error.type`. Spans are made at any log level; without a tracer provider they are no-ops.
 *
 * At trace level it also logs the call with its arguments, each emission, and how it ended, with
 * its duration. Bare, on the default `log`; with `logger`, on it; with `options`, a function of each
 * call's `this` and arguments, on a Logger on the `logger` sink it returns, at its `logLevel`, and
 * on nothing when it returns no `logger`:
 *
 *     TRACE RequestId: … Lambda LambdaResponse.into Called
 *     TRACE RequestId: … Lambda LambdaResponse.into Emitted Duration: 2.12 ms Value: Result(…)
 *     TRACE RequestId: … Lambda LambdaResponse.into Completed Duration: 2.15 ms Emissions: 1
 *
 * A failure logs `Failed` with the error, a subscription unsubscribed first (the loser of a `race`,
 * an aborted request) `Unsubscribed`, and an Observable left for later `Returned`. Values that are
 * not Loggable are logged by their class name only.
 */
export const Trace: {
  /** `@Trace`: logs on the default `log`. */
  <This, Args extends unknown[], R>(
    value: Method<This, Args, R>,
    context: ClassMethodDecoratorContext<This, Method<This, Args, R>>
  ): Method<This, Args, R>;
  /** `@Trace(logger)`. */
  (logger?: Logger): Decorator;
  /**
   * `@Trace(options)`: `options` is called on every call, with its `this` and arguments. `T extends
   * This` lets a static method, whose `this` is its class, take a function that ignores `this`.
   */
  <This, Args extends unknown[]>(
    options: (this: This, ...args: Args) => CdkOptions | undefined
  ): <T extends This, R>(
    value: Method<T, Args, R>,
    context: ClassMethodDecoratorContext<T, Method<T, Args, R>>
  ) => Method<T, Args, R>;
} = ((
  first?: Logger | Method<unknown, unknown[], unknown>,
  second?: ClassMethodDecoratorContext
): Decorator | Method<unknown, unknown[], unknown> => {
  if (isDecoratorContext(second)) {
    return decorate(() => log)(first as Method<unknown, unknown[], unknown>, second);
  }
  if (typeof first === 'function') {
    return decorate(fromOptions(first as (this: unknown, ...args: unknown[]) => CdkOptions | undefined));
  }
  const logger = first ?? log;
  return decorate(() => logger);
}) as never;
