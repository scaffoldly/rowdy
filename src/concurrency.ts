import { cpus } from 'os';

const LIMITS = { MIN: 1, MAX: 10 };
let current = 0;

/** How many requests rowdy makes at once: one per CPU, from 1 to 10. */
export const concurrency = (): number => {
  if (current === 0) {
    current = Math.min(Math.max(LIMITS.MIN, cpus()?.length || LIMITS.MIN), LIMITS.MAX);
  }
  return current;
};
