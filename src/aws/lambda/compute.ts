import { defer, last, map, merge, Observable, throwError } from 'rxjs';
import { deploySources } from '../../api/internal/layers';
import { Exec } from '../../api/types';
import type { Event } from '../../events';
import { Environment } from '../../environment';
import { ExecSchema } from '../../routes';
import { ComputeSpec, SandboxCompute } from '../../sandbox/internal/compute';
import { LambdaImageService } from './image';
import { LambdaFunction } from './index';

export class LambdaCompute implements SandboxCompute {
  // Only /tmp is writable on Lambda. The XDG directories are the spec's defaults under that HOME.
  static readonly env = {
    HOME: '/tmp',
    XDG_CACHE_HOME: '/tmp/.cache',
    XDG_CONFIG_HOME: '/tmp/.config',
    XDG_DATA_HOME: '/tmp/.local/share',
    XDG_STATE_HOME: '/tmp/.local/state',
  };

  // Lambda takes Timeout in whole seconds, 1 to 900, and MemorySize in whole MB, 128 to 10240.
  static assert({ timeout, memory }: Pick<ComputeSpec, 'timeout' | 'memory'>): void {
    if (!Number.isInteger(timeout / 1000) || timeout < 1000 || timeout > 900_000) {
      throw new RangeError(`timeout must be whole seconds from 1000 to 900000 ms, got ${timeout}`);
    }
    if (!Number.isInteger(memory) || memory < 128 || memory > 10240) {
      throw new RangeError(`memory must be whole MB from 128 to 10240, got ${memory}`);
    }
  }

  readonly stoppable = false;

  private lambda: LambdaFunction;

  constructor(private environment: Environment) {
    this.lambda = new LambdaFunction(
      'Sandbox',
      new LambdaImageService(environment).withLayersFrom(deploySources(undefined))
    );
  }

  get sandboxId(): string {
    const { FunctionArn } = this.lambda.State;
    if (!FunctionArn) {
      throw new Error('Sandbox has no function');
    }
    return FunctionArn;
  }

  create({ image, name, timeout, memory, env }: ComputeSpec): Observable<this> {
    this.lambda
      .withImage(image)
      .withCommand([])
      .withTimeout(timeout / 1000)
      .withMemory(memory)
      // The suffix keeps a sandbox off a function deployed any other way, whose exec must stay off.
      .withName(name);
    Object.entries(env).forEach(([key, value]) => this.lambda.withEnvironment(key, value));

    return defer(() => this.lambda.observe()).pipe(
      last(),
      map(() => this)
    );
  }

  attach(sandboxId: string): Observable<this> {
    return defer(() => this.lambda.withArn(sandboxId)).pipe(
      map((lambda) => {
        // Exec is refused on any other function, so a handle to one could never run a command.
        if (lambda.Status.Configuration?.Environment?.Variables?.ROWDY_SANDBOX !== 'true') {
          throw new Error(`Not a sandbox: ${sandboxId}`);
        }
        return this;
      })
    );
  }

  exec(event: ExecSchema): Observable<Exec> {
    return this.lambda.exec(event);
  }

  events(): Observable<Event> {
    return merge(this.lambda.events(), this.environment.event$);
  }

  stop(): Observable<this> {
    return throwError(() => new Error('stop is not implemented on runtime aws.lambda'));
  }
}
