import { AxiosInstance } from 'axios';
import { Logger } from '../log';
import { Observable } from 'rxjs';
import { Environment } from '../environment';

export interface IApi {
  http: AxiosInstance;
  log: Logger;
  environment: Environment | undefined;
  Registry: IRegistryApi;
}

export interface IImageApi {
  log: Logger;
  http: AxiosInstance;
  pullImage(image: string): Observable<PulledImage>;
  // getImage(req: Image['Req'], opts?: Image['Opts']['GET']): Observable<ApiSchema<Image['Req'], Image['Res']>>;
  // putImage(req: Image['Req'], opts?: Image['Opts']['PUT']): Observable<ApiSchema<Image['Req'], Image['Res']>>;
}

export interface IRegistryApi {
  log: Logger;
  http: AxiosInstance;
  infer(): Observable<IRegistryApi>;
  getRegistry(req?: Registry['Req']): Observable<ApiSchema<Registry['Req'], Registry['Res']>>;
}

export type ApiVersion = 'rowdy.run/v1alpha1';
export type ApiKind = 'Routes' | 'NotFound' | 'BadRequest' | Health['kind'] | Image['kind'] | Registry['kind'];
export type ApiSchema<Spec, Status> = {
  apiVersion: ApiVersion;
  kind: ApiKind;
  spec?: Spec;
  status: Status;
};

export type ApiResponseStatus = {
  code: number;
  headers?: { [key: string]: string | string[] };
  reason?: string | undefined;
};

export type Health = {
  kind: 'Health';
  req: never;
  opts: never;
  res: { healthy: boolean };
};

export type Registry = {
  kind: 'Registry';
  Req: {
    registry?: string;
    authorization?: string;
  };
  Res: ApiResponseStatus & {
    registry: string;
  };
};

export type Image = {
  kind: 'Image';
  Req: {
    image: string | string[];
  };
  Opts: {
    GET: {
      authorization?: string;
    };
    PUT: Image['Opts']['GET'] & {
      namepace?: string;
      registry?: string;
    };
  };
  Res: ApiResponseStatus & {
    registry: string;
    namespace: string;
    name: string;
    reference: string;
    tags: string[];
    index: Image['External']['ImageIndex'];
    images: Record<string, Image['External']['ImageManifest']>;
    blobs: (Image['External']['Ref'] & { platform: string; url: string })[];
  };
  External: {
    Ref: Partial<{
      mediaType: string;
      size: number;
      digest: string;
      annotations: Record<string, string>;
    }>;
    Config: Image['External']['Ref'];
    Layer: Image['External']['Ref'];
    Manifest: Image['External']['Ref'] & Partial<{ platform: Partial<{ architecture: string; os: string }> }>;
    ImageIndex: Image['External']['Ref'] &
      Partial<{
        schemaVersion: number;
        mediaType:
          | 'application/vnd.oci.image.index.v1+json'
          | 'application/vnd.docker.distribution.manifest.list.v2+json';
        manifests: Image['External']['Manifest'][];
      }>;
    ImageManifest: Image['External']['Manifest'] &
      Partial<{
        schemaVersion: number;
        mediaType:
          | 'application/vnd.oci.image.manifest.v1+json'
          | 'application/vnd.docker.distribution.manifest.v2+json';
        config: Image['External']['Config'];
        layers: Image['External']['Layer'][];
      }>;
  };
};

export type PulledImage = {
  image: string;
  imageRef: string;
};
