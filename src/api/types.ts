import { AxiosInstance } from 'axios';
import { Logger } from '../log';
import { MonoTypeOperatorFunction, Observable } from 'rxjs';
import { Environment } from '../environment';

export type ApiVersion = 'rowdy.run/v1alpha1';
export type ApiKind = 'Routes';
export type ApiSchema<Spec, Status> = {
  apiVersion: ApiVersion;
  kind: ApiKind;
  spec?: Spec;
  status: Status;
};

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
  image: string;
  imageRef: string;
};

export type TRegistry = {
  registry: string;
  authorization?: string;
  withSlug: (slug: string) => Observable<TRegistry>;
};
