/** What each type of event goes through, as `[before, after]`. */
export const LIFECYCLES = {
  describe: ['describing', 'described'],
  read: ['reading', 'read'],
  create: ['creating', 'created'],
  update: ['updating', 'updated'],
  dispose: ['disposing', 'disposed'],
  tag: ['tagging', 'tagged'],
} as const;

export type CdkEventType = keyof typeof LIFECYCLES;

/**
 * A step in managing a resource. `type` narrows `lifecycle`, and `failed` can follow any of them.
 *
 * `client` and `action` come from a `ClientLogger`, `resource` from a `CloudResource`.
 */
export type CdkEvent = {
  [Type in CdkEventType]: {
    type: Type;
    lifecycle: (typeof LIFECYCLES)[Type][number] | 'failed';
    /** Like `IAMClient`. */
    client?: string;
    /** The command without its `Command` suffix, like `CreateRole`. */
    action?: string;
    /** Like `IAM Role`. */
    resource?: string;
    /** What it's about. */
    name?: string;
  };
}[CdkEventType];
