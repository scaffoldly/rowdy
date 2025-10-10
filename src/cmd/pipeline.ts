import { NEVER, Observable } from 'rxjs';
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
    const [cmd, ...args] = this.command || [];
    if (!cmd) {
      log.debug('Command Pipeline: DISABLED: No command specified');
      return NEVER;
    }

    if (!this.proc && this.restart) {
      this.proc = spawn(cmd, args, { stdio: 'inherit', env: this.env });

      this.proc.on('exit', (code) => {
        log.warn(`Process exited`, { cmd, args, pid: this.proc?.pid, code });
        delete this.proc;

        if (this.restart) {
          setTimeout(() => this.into().subscribe(), 1000);
        }
      });

      this.proc.on('error', (err) => {
        log.warn(`Process error`, { cmd, args, pid: this.proc?.pid, err });
        delete this.proc;

        if (this.restart) {
          setTimeout(() => this.into().subscribe(), 1000);
        }
      });

      log.debug('Started process', { pid: this.proc.pid });
    }

    return NEVER;
  }

  override repr(): string {
    return `CommandPipeline(command=${Logger.asPrimitive(this.command)}, pid=${Logger.asPrimitive(this.proc?.pid)})`;
  }
}
