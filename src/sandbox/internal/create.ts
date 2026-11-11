import type { Observable } from 'rxjs';
import type { Event, Sandbox, SandboxPromise } from '..';
import type { SandboxImpl } from './sandbox';

export class SandboxPromiseImpl implements SandboxPromise, Promise<SandboxImpl> {
  readonly [Symbol.toStringTag] = 'SandboxPromise';

  constructor(
    private created: Promise<SandboxImpl>,
    private sandbox: SandboxImpl
  ) {
    // Its methods can be called later, so a failed create isn't an unhandled rejection meanwhile. Awaiting it, or a
    // call, still rejects.
    this.created.catch(() => {});
  }

  events(): Observable<Event> {
    return this.sandbox.events();
  }

  // The sandbox's own methods, each once it's there. A failed create is each call's error.
  readonly runCommand = ((...args: unknown[]) =>
    this.created.then((sandbox) =>
      (sandbox.runCommand as (...args: unknown[]) => ReturnType<Sandbox['runCommand']>)(...args)
    )) as Sandbox['runCommand'];
  readonly output: Sandbox['output'] = (...args) => this.created.then((sandbox) => sandbox.output(...args));
  readonly writeFiles: Sandbox['writeFiles'] = (...args) => this.created.then((sandbox) => sandbox.writeFiles(...args));
  readonly readFileToBuffer: Sandbox['readFileToBuffer'] = (...args) =>
    this.created.then((sandbox) => sandbox.readFileToBuffer(...args));
  readonly mkDir: Sandbox['mkDir'] = (...args) => this.created.then((sandbox) => sandbox.mkDir(...args));
  readonly status: Sandbox['status'] = () => this.created.then((sandbox) => sandbox.status());
  readonly stop: Sandbox['stop'] = () => this.created.then((sandbox) => sandbox.stop());
  readonly delete: Sandbox['delete'] = () => this.created.then((sandbox) => sandbox.delete());

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
