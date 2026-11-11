import { combineLatest, concat, fromEvent, map, Observable, switchMap, takeUntil, tap, toArray } from 'rxjs';
import { AwsClientLogger } from './logger';

/**
 * What a resource does in AWS, step by step. `creates` run together, each emitting once what it found or made, then
 * `updates` and `tags` run in order. `deletes` run in order, so what depends on something goes before it.
 */
export type AwsSteps = {
  creates: Observable<unknown>[];
  updates: Observable<unknown>[];
  tags?: Observable<unknown>[];
  deletes: Observable<unknown>[];
};

/** Something rowdy makes in AWS from what it's given, and takes down again, as the steps its `prepare` lays out. */
export abstract class AwsResource extends AwsClientLogger {
  private deleting = false;

  /** Aborts whatever the resource is doing. */
  abstract get signal(): AbortSignal;

  /** The steps for what the resource is given now, for `observe` or, while `isDeleting`, for `delete`. */
  protected abstract prepare(): AwsSteps;

  isDeleting(): boolean {
    return this.deleting;
  }

  /** Makes or updates the resource, emitting after each step. */
  observe(): Observable<this> {
    return new Observable<this>((subscriber) => {
      this.deleting = false;
      const { creates, updates, tags = [] } = this.prepare();
      const subscription = combineLatest(creates)
        .pipe(
          takeUntil(fromEvent(this.signal, 'abort')),
          tap(() => subscriber.next(this)),
          switchMap(() =>
            concat(...updates, ...tags).pipe(
              tap(() => subscriber.next(this)),
              toArray()
            )
          )
        )
        .pipe(map(() => this))
        .subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
      };
    });
  }

  /** Takes the resource down, emitting after each step. */
  delete(): Observable<this> {
    return new Observable<this>((subscriber) => {
      this.deleting = true;
      const { deletes } = this.prepare();
      // In order: a role's policy goes before the role.
      const subscription = concat(...deletes)
        .pipe(
          takeUntil(fromEvent(this.signal, 'abort')),
          tap(() => subscriber.next(this)),
          toArray()
        )
        .pipe(map(() => this))
        .subscribe(subscriber);

      return () => {
        subscription.unsubscribe();
      };
    });
  }
}
