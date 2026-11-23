import type { Result } from '.';

/**
 * The run ends when the promise-like settles. It is followed, not replaced, so what the method
 * returned keeps its identity and any methods of its own; following it handles its rejection on
 * a branch of its own, and the caller still sees it.
 */
export const promise: Result<PromiseLike<unknown>> = {
  matches: (value): value is PromiseLike<unknown> =>
    typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function',
  trace: (pending, { run }) => {
    pending.then(
      (value) => run.tracker.complete(value),
      (error: unknown) => run.tracker.fail(error)
    );
    return pending;
  },
};
