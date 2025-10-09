import { EMPTY, NEVER, Observable, of, switchMap, timer } from 'rxjs';
import { Pipeline, Request } from '../pipeline';
import { log, Logger, Trace } from '../log';
import { ChildProcess, spawn } from 'child_process';
import { Environment } from '../environment';

// TODO: Probaly use shell proxy?
export class CommandPipeline extends Pipeline {
  private proc?: ChildProcess;
  private restart = true;

  constructor(environment: Environment) {
    super(environment);
    this.signal.addEventListener('abort', () => {
      this.proc?.kill();
      this.restart = false;
    });
  }

  get command(): string[] | undefined {
    return this.environment.command;
  }

  get env(): Record<string, string | undefined> {
    return this.environment.env;
  }

  @Trace
  override into(): Observable<Request<Pipeline>> {
    return (
      of(this.command)
        .pipe(
          switchMap((command) => {
            const [cmd, ...args] = command || [];
            if (!cmd) {
              log.debug('Command Pipeline: DISABLED: No command specified');
              return NEVER;
            }

            if (this.proc) {
              return of(this.proc);
            }

            log.debug(`Spawning process`, { cmd, args });
            const proc = spawn(cmd, args, { stdio: 'inherit', env: this.env });

            proc.on('exit', (code) => {
              log.warn(`Process exited`, { cmd, args, pid: proc.pid, code });
              delete this.proc;
            });

            proc.on('error', (err) => {
              log.warn(`Process error`, { cmd, args, pid: proc.pid, err });
              delete this.proc;
            });

            return of((this.proc = proc));
          })
        )
        // This pipeline runs in the background, so we should never complete this observable.
        .pipe(
          switchMap((proc) => {
            log.debug('Monitoring process', { pid: proc.pid, killed: proc.killed });

            if (!this.restart) {
              return EMPTY;
            }

            return timer(5_000).pipe(switchMap(() => this.into()));
          })
        )
    );
  }

  override repr(): string {
    return `CommandPipeline(command=${Logger.asPrimitive(this.command)}, pid=${Logger.asPrimitive(this.proc?.pid)})`;
  }
}
