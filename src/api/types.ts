import { AxiosInstance } from 'axios';
import { Logger } from '../log';
import { MonoTypeOperatorFunction, Observable } from 'rxjs';
import { Environment } from '../environment';

export type ApiVersion = 'rowdy.run/v1alpha1';
export type ApiKind = 'Routes' | 'Cron' | 'Exec';
export type ApiSchema<Spec, Status> = {
  apiVersion: ApiVersion;
  kind: ApiKind;
  spec?: Spec;
  status: Status;
};

export type ExecFrame = { stream: number; payload: Buffer };

/** A command in a sandbox, running or exited. */
export interface Exec {
  readonly cmdId: string;
  /** Undefined while the command runs. */
  readonly exitCode: number | undefined;
  /** Whether `stdout` or `stderr` lost their start to the limit on what's kept. */
  readonly truncated: boolean;
  /** The stdout written so far, up to the last 1 MiB. */
  stdout(): Promise<string>;
  /** The stderr written so far, up to the last 1 MiB. */
  stderr(): Promise<string>;
  /** Resolves when the command exits, whatever its exit code. */
  wait(): Promise<ExecFinished>;
  /** Every frame so far, then each as it arrives. Completes with the command. */
  readonly frames: Observable<ExecFrame>;
  // TODO: kill
  // kill(signal?: NodeJS.Signals): Promise<void>;
}

export interface ExecFinished extends Exec {
  readonly exitCode: number;
}

export interface IApi {
  http: AxiosInstance;
  log: Logger;
  environment: Environment | undefined;
}

export type PullImageOptions = {
  authorization?: string;
  registry?: string;
  // TODO: Support for plaform annotation
  platform?: 'linux/amd64' | 'linux/arm64';
  layersFrom?: string[];
};

export interface IImageApi {
  log: Logger;
  http: AxiosInstance;
  registry: Observable<TRegistry>;
  pullImage(image: string, opts?: PullImageOptions): Observable<TPulledImage>;
}

export interface IRegistryApi {
  login(): Observable<TRegistry>;
  withSlug(slug: string): MonoTypeOperatorFunction<TRegistry>;
}

export type TPulledImage = {
  Image: string;
  ImageUri: string;
  Command?: string[];
  Entrypoint?: string[];
  Environment?: Record<string, string>;
  WorkDir?: string;
};

export type TRegistry = {
  registry: string;
  authorization?: string;
  withSlug: (slug: string) => Observable<TRegistry>;
};
