import type {
  Command,
  CommandFinished,
  DetachedRunCommandParams,
  ReadFile,
  RunCommandOptions,
  RunCommandParams,
  Sandbox,
  SandboxLookup,
  SandboxOptions,
  WriteFile,
} from '..';

export class SandboxImpl implements Sandbox {
  private constructor() {}

  static async create(_options?: SandboxOptions): Promise<Sandbox> {
    throw new Error('not implemented');
  }

  static async get(_lookup: SandboxLookup): Promise<Sandbox> {
    throw new Error('not implemented');
  }

  get sandboxId(): string {
    throw new Error('not implemented');
  }

  runCommand(cmd: string, args?: string[], options?: RunCommandOptions): Promise<CommandFinished>;
  runCommand(params: DetachedRunCommandParams): Promise<Command>;
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  async runCommand(
    _command: string | RunCommandParams,
    _args?: string[],
    _options?: RunCommandOptions
  ): Promise<Command> {
    throw new Error('not implemented');
  }

  async writeFiles(_files: WriteFile[]): Promise<void> {
    throw new Error('not implemented');
  }

  async readFileToBuffer(_file: ReadFile): Promise<Buffer | null> {
    throw new Error('not implemented');
  }

  async mkDir(_path: string): Promise<void> {
    throw new Error('not implemented');
  }

  async extendTimeout(_duration: number): Promise<void> {
    throw new Error('not implemented');
  }

  async stop(): Promise<void> {
    throw new Error('not implemented');
  }
}
