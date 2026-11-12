import type { CdkEvent } from '@scaffoldly/rowdy-cdk';
import type { TransferEvent } from './api/internal/transfer';
import type { HttpEvents } from './util/axios';

/** A step in something rowdy manages. `source` says where it came from, and the rest depends on it. */
export type Event = { message: string } & (
  | ({ source: 'cdk' } & CdkEvent)
  | ({ source: 'transfer' } & TransferEvent)
  | ({ source: 'http' } & HttpEvents)
);

/** Called with each event, in order. An error it throws is logged, and doesn't affect what emitted it. */
export type EventCallback = (event: Event) => void | PromiseLike<void>;
