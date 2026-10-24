import { Logger } from '@smithy/types';
import { Observable } from 'rxjs';

/** What a deploy wrote to a store: `written` changed, `skipped` did not fit. */
export type Written = { store: string; target: string; written: string[]; skipped: string[] };

/**
 * Where a deploy writes the deployment's state (its Function URL, ARNs and the like) for the CDN in
 * front of a public origin, as `spec.hosts` names it: `{ <host>: <target> }`.
 */
export abstract class CdnStore {
  protected constructor(readonly target: string) {}

  abstract get name(): string;

  /** Upserts every entry that fits; entries already in the store and not in `values` are kept. */
  abstract write(values: Record<string, string>, logger?: Logger): Observable<Written>;
}
