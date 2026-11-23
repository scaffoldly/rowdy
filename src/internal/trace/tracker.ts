/** Follows one run of a traced method: the call, or one subscription to what it returned. */
export interface Tracker {
  /** An Observable subscription starts on this run. */
  subscribe(): void;
  /** An Observable emitted. */
  emit(emission: unknown): void;
  /** The run succeeded; `value` is what a call or a Promise returned. */
  complete(value?: unknown): void;
  fail(error: unknown): void;
  /** An Observable subscription was unsubscribed before it completed or failed. */
  unsubscribe(): void;
  /** The call returned an Observable that it will not follow: the run ends as of `at`. */
  returned(at: number): void;
}

export const all = (trackers: Tracker[]): Tracker => ({
  subscribe: (): void => trackers.forEach((t) => t.subscribe()),
  emit: (emission): void => trackers.forEach((t) => t.emit(emission)),
  // Spread: a run with no value (an Observable's) must not log one.
  complete: (...value): void => trackers.forEach((t) => t.complete(...value)),
  fail: (error): void => trackers.forEach((t) => t.fail(error)),
  unsubscribe: (): void => trackers.forEach((t) => t.unsubscribe()),
  returned: (at): void => trackers.forEach((t) => t.returned(at)),
});
