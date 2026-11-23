/** Follows one subscription to a traced method's Observable. */
export interface Tracker<T> {
  next(emission: T): void;
  error(error: unknown): void;
  complete(): void;
  /** Ended by an unsubscribe before it completed or failed. */
  unsubscribe(): void;
}
