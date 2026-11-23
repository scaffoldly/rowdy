import type { Result } from '.';

/** Anything else: the run ends with the call. */
export const value: Result<unknown> = {
  matches: (_value): _value is unknown => true,
  trace: (returned, { run }) => {
    run.tracker.complete(returned);
    return returned;
  },
};
