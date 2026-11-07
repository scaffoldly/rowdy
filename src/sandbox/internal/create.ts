import type { Observable } from 'rxjs';
import type { Event, SandboxPromise, Tool } from '..';
import type { SandboxImpl } from './sandbox';

export class SandboxPromiseImpl implements SandboxPromise, Promise<SandboxImpl> {
  readonly [Symbol.toStringTag] = 'SandboxPromise';

  constructor(
    private created: Promise<SandboxImpl>,
    private sandbox: SandboxImpl
  ) {}

  events(): Observable<Event> {
    return this.sandbox.events();
  }

  tools(): Tool[] {
    // A host may register these and never await, so a failed build is each call's error, not an unhandled rejection.
    this.created.catch(() => {});
    return this.sandbox.tools(this);
  }

  then<Fulfilled = SandboxImpl, Rejected = never>(
    onfulfilled?: ((value: SandboxImpl) => Fulfilled | PromiseLike<Fulfilled>) | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onrejected?: ((reason: any) => Rejected | PromiseLike<Rejected>) | null
  ): Promise<Fulfilled | Rejected> {
    return this.created.then(onfulfilled, onrejected);
  }

  catch<Rejected = never>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onrejected?: ((reason: any) => Rejected | PromiseLike<Rejected>) | null
  ): Promise<SandboxImpl | Rejected> {
    return this.created.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<SandboxImpl> {
    return this.created.finally(onfinally);
  }
}
