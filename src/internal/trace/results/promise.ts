import type { Result } from '.';

/**
 * The run ends when the promise-like settles.
 *
 * A plain Promise, what an async method returns, is chained: the caller gets one that settles the
 * same way, so a failure nobody handles is still an unhandled rejection. Anything else, a subclass
 * or a promise-like with methods of its own, is followed and returned as it is, keeping its identity
 * and methods; following it handles its rejection on a branch of its own.
 */
export const promise: Result<PromiseLike<unknown>> = {
  matches: (value): value is PromiseLike<unknown> =>
    typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function',
  trace: (pending, { run }) => {
    if (Object.getPrototypeOf(pending) === Promise.prototype) {
      return pending.then(
        (value) => {
          run.tracker.complete(value);
          return value;
        },
        (error: unknown) => {
          run.tracker.fail(error);
          throw error;
        }
      );
    }
    pending.then(
      (value) => run.tracker.complete(value),
      (error: unknown) => run.tracker.fail(error)
    );
    return pending;
  },
};
