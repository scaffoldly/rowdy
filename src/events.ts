import type { CdkEvent } from '@scaffoldly/rowdy-cdk';

/** A step in something rowdy manages. `source` says where it came from, and the rest depends on it. */
export type Event = { source: 'cdk' } & CdkEvent;

/** Called with each event, in order. An error it throws is logged, and doesn't affect what emitted it. */
export type EventCallback = (event: Event) => void | PromiseLike<void>;
