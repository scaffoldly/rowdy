import { catchError, from, map, mergeAll, mergeMap, Observable, of, tap, throwError, toArray } from 'rxjs';
import { Pipeline } from '../pipeline';
import { HttpProxy } from '../proxy/http';
import { match } from 'path-to-regexp';
import { Logger } from '../log';
import axios, { AxiosInstance } from 'axios';
import { authenticate } from '../util/axios';

export type ApiVersion = 'rowdy.run/v1alpha1';
export type ApiKind = 'Routes' | 'NotFound' | Health['kind'] | Image['kind'];
export type ApiSchema<Spec, Status> = {
  apiVersion: ApiVersion;
  kind: ApiKind;
  spec?: Spec;
  status: Status;
};

export type ApiResponseStatus = {
  code: number;
  headers?: { [key: string]: string | string[] };
  reason?: string;
};

export type Health = {
  kind: 'Health';
  req: never;
  opts: never;
  res: { healthy: boolean };
};

type Ref<T extends string> = Partial<{
  mediaType: T;
  size: number;
  digest: string;
  annotations: Record<string, string>;
}>;

type Config = Ref<'application/vnd.oci.image.config.v1+json'>;
type Layer = Ref<'application/vnd.oci.image.layer.v1.tar+gzip' | 'application/vnd.oci.image.layer.v1.tar'>;
type Manifest = Ref<'application/vnd.oci.image.manifest.v1+json'> &
  Partial<{ platform: Partial<{ architecture: string; os: string }> }>;

type ImageManifest = Partial<{
  schemaVersion: number;
  mediaType: 'application/vnd.oci.image.manifest.v1+json';
  config: Config;
  layers: Layer[];
}>;

type IndexManifest = Partial<{
  schemaVersion: number;
  mediaType: 'application/vnd.oci.image.index.v1+json';
  manifests: Manifest[];
}>;

export type Image = {
  kind: 'Image';
  req: {
    image: string | string[];
  };
  opts: { authorization?: string | undefined };
  res: ApiResponseStatus & {
    registry: string;
    namespace: string;
    name: string;
    reference: string;
    tags: string[];
    index: IndexManifest;
    images: Record<string, ImageManifest>;
    blobs: (Ref<string> & { platform: string; url: string })[];
  };
};

export class Api {
  private proxy?: HttpProxy<Pipeline>;
  private axios: AxiosInstance = axios.create();

  constructor(private log: Logger = log) {
    this.axios.interceptors.response.use(...authenticate(this.axios, this.log));
  }

  private routes = {
    GET: [
      {
        match: match<Health['req']>('/health'),
        handler: this.health.bind(this),
      },
      {
        match: [match<Image['req']>('/images/*image')],
        handler: this.image.bind(this),
      },
    ],
  };

  withProxy(proxy: HttpProxy<Pipeline>): this {
    this.proxy = proxy;
    this.axios.defaults.headers.common['User-Agent'] = proxy.headers.userAgent;
    return this;
  }

  health(): Observable<ApiSchema<Health['res'], ApiResponseStatus>> {
    return of({
      apiVersion: 'rowdy.run/v1alpha1',
      kind: 'Health',
      spec: { healthy: true },
      status: {
        code: 200,
      },
    });
  }

  image(req: Image['req'], opts?: Image['opts']): Observable<ApiSchema<Image['req'], Image['res']>> {
    let { image } = req;
    if (typeof image === 'string') {
      image = image.split('/');
    }
    let registry: string | undefined = 'registry-1.docker.io';
    let namespace: string | undefined = 'library';
    let name: string | undefined = undefined;
    let reference = 'latest';

    if (image.length > 3) {
      return throwError(() => new Error(`Image name has too many segments`));
    }

    if (image.length === 3) {
      registry = image[0] || registry;
      namespace = image[1] || namespace;
      name = image[2];
    }

    if (image.length === 2) {
      registry = 'registry-1.docker.io';
      namespace = image[0] || namespace;
      name = image[1];
    }

    if (image.length === 1) {
      registry = 'registry-1.docker.io';
      namespace = 'library';
      name = image[0];
    }

    if (name?.includes('@sha256:')) {
      [name, reference = ''] = name.split('@sha256:');
      if (!reference) {
        return throwError(() => new Error('Invalid image name'));
      }
      reference = `sha256:${reference}`;
    }

    if (!reference && name?.includes(':')) {
      [name, reference = 'latest'] = name.split(':');
    }

    if (!name) {
      return throwError(() => new Error('Invalid image name'));
    }

    const url = (reference: string, slug: 'manifests' | 'blobs' = 'manifests'): string =>
      `https://${registry}/v2/${namespace}/${name}/${slug}/${reference}`;

    req.image = `${registry}/${namespace}/${name}:${reference}`;

    const res: Image['res'] = {
      code: 200,
      registry,
      namespace,
      name,
      reference,
      index: {},
      images: {},
      blobs: [],
      tags: [],
    };

    if (!reference.startsWith('sha256:')) {
      res.tags.push(reference);
    }

    const respond = (spec: Image['req'], status: Image['res']): Observable<ApiSchema<Image['req'], Image['res']>> => {
      this.log.debug(`Image Spec`, JSON.stringify(spec, null, 2));
      this.log.debug(`Image Status`, JSON.stringify(status, null, 2));
      return of({
        apiVersion: 'rowdy.run/v1alpha1',
        kind: 'Image',
        spec,
        status,
      });
    };

    const headers: Record<string, string | string[] | undefined> = {
      Accept: ['application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json'],
      Authorization: opts?.authorization,
    };

    return of(url(reference))
      .pipe(
        mergeMap((u) =>
          from(this.axios.get<IndexManifest>(u, { headers })).pipe(
            tap(() => this.log.debug(`Fetched index manifest from ${u}`)),
            map(({ data, headers, config }) => {
              if (data.schemaVersion !== 2 || data.mediaType !== 'application/vnd.oci.image.index.v1+json') {
                this.log.warn('Unsupported schemaVersion or mediaType', {
                  schemaVersion: data.schemaVersion,
                  mediaType: data.mediaType,
                  url: u,
                });
                return [];
              }

              if (config.headers.Authorization) {
                opts = { ...opts, authorization: config.headers.Authorization as string };
              }

              res.reference = headers['docker-content-digest'] || reference;
              res.index = data;
              res.index.manifests = (res.index.manifests || []).filter(
                (m) => m.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest' // TODO: attestations
              );

              return res.index.manifests
                .filter(
                  (m) =>
                    !!m.digest &&
                    !!m.platform?.os &&
                    m.platform.os !== 'unknown' &&
                    !!m.platform.architecture &&
                    m.platform.architecture !== 'unknown'
                )
                .map((m) => ({
                  platform: `${m.platform!.os}/${m.platform!.architecture}`,
                  digest: m.digest!,
                  url: url(m.digest!),
                }));
            }),
            mergeAll()
          )
        )
      )
      .pipe(
        mergeMap(({ platform, digest, url: u }) =>
          from(this.axios.get<ImageManifest>(u, { headers })).pipe(
            tap(() => this.log.debug(`Fetched ${platform} image manifest from ${u}`)),
            map(({ data }) => {
              if (data.schemaVersion !== 2 || data.mediaType !== 'application/vnd.oci.image.manifest.v1+json') {
                this.log.warn('Unsupported schemaVersion or mediaType', {
                  schemaVersion: data.schemaVersion,
                  mediaType: data.mediaType,
                  url: u,
                });
                return;
              }

              res.images[digest] = data;
              if (data.config && data.config.digest) {
                res.blobs.push({ ...data.config, platform, url: url(data.config.digest, 'blobs') });
              }
              res.blobs.push(
                ...(data.layers || [])
                  .filter((layer) => !!layer.digest)
                  .map((layer) => ({ ...layer, platform, url: url(layer.digest!, 'blobs') }))
              );
            })
          )
        )
      )
      .pipe(toArray())
      .pipe(mergeMap(() => respond(req, res)))
      .pipe(
        catchError((err) => {
          this.log.warn(`Error fetching image ${req.image}: ${err.message}`);
          res.code = 206;
          res.reason = err.message;
          return respond(req, res);
        })
      );
  }

  handle(): Observable<ApiSchema<unknown, ApiResponseStatus>> {
    const handler = this.handler();

    if (!handler) {
      return this.notFound('No matching route');
    }

    return handler;
  }

  private handler(): Observable<ApiSchema<unknown, ApiResponseStatus>> | undefined {
    if (!this.proxy) {
      this.log.warn('No proxy set on API');
      return undefined;
    }

    const { method, body } = this.proxy;
    const handlers = this.routes[method.toUpperCase() as keyof typeof this.routes];
    if (!handlers) {
      this.log.warn(`No handlers for method: ${method}`);
      return undefined;
    }

    const { pathname: path, searchParams } = this.proxy.uri;
    // TODO: handle encoding? or does body.toString() already do that
    // TODO: type checking and opts validation
    let opts = { ...Object.fromEntries(searchParams), ...(body.length ? JSON.parse(body.toString()) : {}) };

    return handlers.reduce(
      (acc, { match: matcher, handler }) => {
        if (acc) return acc;
        const matchers = Array.isArray(matcher) ? matcher : [matcher];
        const matches = matchers.map((m) => m(path)).find((m) => m !== false);
        if (!matches) return acc;
        return handler(matches.params, opts);
      },
      undefined as Observable<ApiSchema<unknown, ApiResponseStatus>> | undefined
    );
  }

  private notFound(reason: string): Observable<ApiSchema<undefined, ApiResponseStatus>> {
    return of({
      apiVersion: 'rowdy.run/v1alpha1',
      kind: 'NotFound',
      spec: undefined,
      status: {
        code: 404,
        reason,
      },
    });
  }
}
