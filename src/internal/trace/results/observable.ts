import { context as otel, trace } from '@opentelemetry/api';
import { finalize, isObservable, Observable, tap } from 'rxjs';
import type { Run } from '../run';
import type { Result } from '.';

/**
 * The call's run follows the first subscription when it subscribes straight away, before the next
 * microtask, under the span active at the call. Otherwise the call's run ends as `returned`, as of
 * when the call returned, and every subscription, each retry or second subscriber too, is a run of
 * its own, under the span active when it subscribes.
 */
export const observable: Result<Observable<unknown>> = {
  matches: isObservable,
  trace: (source, call) => {
    const returnedAt = performance.now();
    let handover: Run | undefined = call.run;
    const release = (): void => {
      handover?.tracker.returned(returnedAt);
      handover = undefined;
    };
    queueMicrotask(release);

    return new Observable((subscriber) => {
      const sameSpan = trace.getSpan(otel.active()) === trace.getSpan(call.parent);
      const taken = sameSpan ? handover : undefined;
      if (taken) handover = undefined;
      else release();
      const run = taken ?? call.again();
      run.tracker.subscribe();
      call.annotate?.(run);
      let settled = false;

      return otel.with(run.context, () =>
        source
          .pipe(
            // Before the outcome reaches the subscriber, so the span has ended when it does.
            tap({
              next: (emission) => run.tracker.emit(emission),
              error: (error: unknown) => {
                settled = true;
                run.tracker.fail(error);
              },
              complete: () => {
                settled = true;
                run.tracker.complete();
              },
            }),
            finalize(() => {
              if (!settled) run.tracker.unsubscribe();
            })
          )
          .subscribe(subscriber)
      );
    });
  },
};
