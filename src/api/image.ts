import {
  catchError,
  concatMap,
  defer,
  from,
  map,
  merge,
  mergeAll,
  mergeMap,
  Observable,
  of,
  switchMap,
  tap,
  throwError,
  toArray,
} from 'rxjs';
import { AxiosInstance, isAxiosError } from 'axios';
import { ApiSchema, IApi, Image } from './types';
import { Readable } from 'stream';
import { ILoggable, Logger } from '../log';

export class ImageApi {
  static readonly CONCURRENCY = 1;

  constructor(private api: IApi) {}

  get http(): AxiosInstance {
    return this.api.http;
  }

  get log(): Logger {
    return this.api.log;
  }

  putImage(req: Image['Req'], opts?: Image['Opts']['PUT']): Observable<ApiSchema<Image['Req'], Image['Res']>> {
    this.log.info(`Transferring image ${req.image} (concurrency: ${ImageApi.CONCURRENCY})`);

    const toImage: Image['Res'] = {
      code: 206,
      registry: '',
      namespace: '',
      name: '',
      reference: '',
      index: {},
      images: {},
      blobs: [],
      tags: [],
    };

    return this.getImage(req, opts)
      .pipe(
        switchMap(({ status: fromImage }) =>
          this.api.Registry.getRegistry(opts).pipe(
            map(({ status }) => ({
              fromImage,
              toRegistry: status.registry,
              toNamespace: opts?.namepace || fromImage.namespace,
            }))
          )
        ),
        map(({ fromImage, toRegistry, toNamespace }) => {
          toImage.registry = toRegistry;
          toImage.namespace = toNamespace;
          toImage.name = fromImage.name;
          toImage.reference = fromImage.reference;
          return { fromImage };
        }),
        map(({ fromImage }) => {
          const transfers: Transfer[] = [];

          transfers.push(
            // Blobs
            ...fromImage.blobs.map((blob) => {
              const fromUrl = blob.url;
              const toUrl = fromUrl.replace(fromImage.registry, toImage.registry).replace(blob.digest!, `uploads/`);
              return new Transfer(this.api, fromUrl, toUrl, blob, () => {
                toImage.blobs.push({ ...blob, url: toUrl });
              });
            })
          );

          transfers.push(
            // Image Manifests
            ...Object.entries(fromImage.images).map(([digest, manifest]) => {
              const fromUrl = `${fromImage.registry}/${fromImage.namespace}/${fromImage.name}/manifests/${digest}`;
              const toUrl = fromUrl.replace(fromImage.registry, toImage.registry);
              return new Transfer(this.api, fromUrl, toUrl, manifest, () => {
                toImage.images[digest] = manifest;
              });
            })
          );

          transfers.push(
            // Index Manifest
            new Transfer(
              this.api,
              `${fromImage.registry}/${fromImage.namespace}/${fromImage.name}/manifests/${fromImage.reference}`,
              `${toImage.registry}/${toImage.namespace}/${toImage.name}/manifests/${toImage.reference}`,
              {
                digest: fromImage.reference,
                mediaType: fromImage.index.mediaType!,
                // size: fromImage.index.size!,
              },
              () => {
                toImage.index = fromImage.index;
              }
            )
          );

          transfers.push(
            // Tags
            ...fromImage.tags.map((tag) => {
              const fromUrl = `${fromImage.registry}/${fromImage.namespace}/${fromImage.name}/manifests/${tag}`;
              const toUrl = fromUrl.replace(fromImage.registry, toImage.registry);
              return new Transfer(
                this.api,
                fromUrl,
                toUrl,
                {
                  digest: tag,
                  mediaType: fromImage.index.mediaType!,
                  // size: fromImage.index.size!,
                },
                () => {
                  toImage.tags.push(tag);
                }
              );
            })
          );

          this.log.info(`Prepared ${transfers.length} transfers for image ${req.image}`);
          return { fromImage, transfers: transfers.slice(0, 1) };
        })
      )
      .pipe(
        switchMap(({ fromImage, transfers }) =>
          merge(...transfers.map((transfer) => transfer.pipe()), ImageApi.CONCURRENCY).pipe(
            toArray(),
            map(() => ({ fromImage }))
          )
        )
      )
      .pipe(
        map(({ fromImage }) => {
          const response: ApiSchema<Image['Req'], Image['Res']> = {
            apiVersion: 'rowdy.run/v1alpha1',
            kind: 'Image',
            spec: {
              image: `${fromImage.registry}/${fromImage.namespace}/${fromImage.name}:${fromImage.reference}`,
            },
            status: {
              ...toImage,
              code: 200,
            },
          };
          return response;
        }),
        catchError((err) => {
          const response: ApiSchema<Image['Req'], Image['Res']> = {
            apiVersion: 'rowdy.run/v1alpha1',
            kind: 'Image',
            spec: {
              image: req.image,
            },
            status: { ...toImage, reason: err.message, code: isAxiosError(err) ? err.response?.status || 500 : 500 },
          };
          return of(response);
        }),
        tap((response) => {
          this.log.debug(`Image Spec`, JSON.stringify(response.spec));
          this.log.debug(`Image Status`, JSON.stringify(response.status));
          this.log.info(`Finished transferring image ${req.image} with status code ${response.status.code}`);
        })
      );
  }

  getImage(req: Image['Req'], opts?: Image['Opts']['GET']): Observable<ApiSchema<Image['Req'], Image['Res']>> {
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

    if (!reference.startsWith('sha256:') && name?.includes(':')) {
      [name, reference = 'latest'] = name.split(':');
    }

    if (!name) {
      return throwError(() => new Error('Invalid image name'));
    }

    const url = (reference: string, slug: 'manifests' | 'blobs' = 'manifests'): string =>
      `https://${registry}/v2/${namespace}/${name}/${slug}/${reference}`;

    req.image = `${registry}/${namespace}/${name}:${reference}`;

    const res: Image['Res'] = {
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

    const respond = (spec: Image['Req'], status: Image['Res']): Observable<ApiSchema<Image['Req'], Image['Res']>> => {
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
      Accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ],
      Authorization: opts?.authorization,
    };

    return of(url(reference))
      .pipe(
        mergeMap((u) =>
          from(this.http.get<Image['External']['ImageIndex']>(u, { headers })).pipe(
            tap(() => this.log.debug(`Fetched index manifest from ${u}`)),
            map(({ data, headers, config }) => {
              if (data.schemaVersion !== 2) {
                res.index = data;
                throw new Error(`Unsupported schemaVersion on index: ${data.schemaVersion}`);
              }
              if (
                data.mediaType !== 'application/vnd.oci.image.index.v1+json' &&
                data.mediaType !== 'application/vnd.docker.distribution.manifest.list.v2+json'
              ) {
                res.index = data;
                throw new Error(`Unsupported mediaType on index: ${data.mediaType}`);
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
          from(this.http.get<Image['External']['ImageManifest']>(u, { headers })).pipe(
            tap(() => this.log.debug(`Fetched ${platform} image manifest from ${u}`)),
            map(({ data }) => {
              if (data.schemaVersion !== 2) {
                res.images[digest] = data;
                throw new Error(`Unsupported schemaVersion on ${digest}: ${data.schemaVersion}`);
              }
              if (
                data.mediaType !== 'application/vnd.oci.image.manifest.v1+json' &&
                data.mediaType !== 'application/vnd.docker.distribution.manifest.v2+json'
              ) {
                res.images[digest] = data;
                throw new Error(`Unsupported mediaType on ${digest}: ${data.mediaType}`);
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
}

class Transfer implements ILoggable {
  constructor(
    public api: IApi,
    public fromUrl: string,
    public toUrl: string,
    public ref: Image['External']['Ref'],
    public finalizer: () => void
  ) {}

  get log(): Logger {
    return this.api.log;
  }

  get http(): AxiosInstance {
    return this.api.http;
  }

  get digest(): string {
    if (!this.ref.digest) {
      throw new Error('Transfer has no digest');
    }
    return this.ref.digest;
  }

  get mediaType(): string {
    if (!this.ref.mediaType) {
      throw new Error('Transfer has no mediaType');
    }
    return this.ref.mediaType;
  }

  public pipe(): Observable<void> {
    return defer(async () => {
      if (!this.toUrl.endsWith('uploads/')) {
        throw new Error('TODO: Not implemented');
      }

      this.log.info(`Transferring blob ${this.digest} from ${this.fromUrl} to ${this.toUrl}`);
      const start = await this.http.post(this.toUrl, null);
      let location = start.headers['location'] || start.headers['Location'];

      const download = await this.http.get<Readable>(this.fromUrl, {
        responseType: 'stream',
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      const responses = new Observable<Promise<void>>((subscriber) => {
        download.data.on('data', async (chunk: Buffer) => {
          subscriber.next(
            this.http
              .patch(location, chunk, {
                headers: {
                  'Content-Type': 'application/octet-stream',
                  'Content-Length': chunk.length,
                },
              })
              .then((res) => {
                location = res.headers['location'] || res.headers['Location'];
              })
              .catch((err) => subscriber.error(err))
          );
        });
        download.data.on('end', () => {
          subscriber.next(
            this.http
              .put(`${location}?digest=${this.digest}`, null, {})
              .then(() => {})
              .catch((err) => subscriber.error(err))
          );
          subscriber.complete();
        });
        download.data.on('error', (err) => subscriber.error(err));
      });

      return responses;
    }).pipe(
      concatMap((responses) => responses),
      toArray(),
      map((responses) => {
        this.log.info(`Completed transfer of blob ${this.digest} with ${responses.length} chunks`);
        this.finalizer();
      })
    );
  }

  repr(): string {
    return `Transfer(from=${this.fromUrl}, to=${this.toUrl}, digest=${this.digest}, mediaType=${this.mediaType})`;
  }
}
