import {
  catchError,
  concat,
  concatMap,
  defer,
  from,
  lastValueFrom,
  map,
  mergeAll,
  mergeMap,
  Observable,
  of,
  OperatorFunction,
  reduce,
  retry,
  switchMap,
  tap,
  throwError,
  timer,
  toArray,
} from 'rxjs';
import { AxiosInstance, AxiosResponse, isAxiosError } from 'axios';
import { ApiSchema, IApi, Image } from './types';
import { Readable } from 'stream';
import { ILoggable, Logger } from '../log';

const registryUrl = (
  registry: string,
  namespace: string,
  name: string,
  reference: string,
  slug: 'manifests' | 'blobs'
): string => `https://${registry}/v2/${namespace}/${name}/${slug}/${reference}`;

export class ImageApi {
  static readonly CONCURRENCY = 5;
  static readonly LIMIT = Infinity;

  constructor(private api: IApi) {}

  get http(): AxiosInstance {
    return this.api.http;
  }

  get log(): Logger {
    return this.api.log;
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

    return of(registryUrl(registry, namespace, name, reference, 'manifests'))
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
              return (res.index.manifests || []).map((m) => ({
                platform: `${m.platform?.os}/${m.platform?.architecture}`,
                digest: m.digest!,
                url: registryUrl(registry, namespace, name, m.digest!, 'manifests'),
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
                res.blobs.push({
                  ...data.config,
                  platform,
                  url: registryUrl(registry, namespace, name, data.config.digest, 'blobs'),
                });
              }
              res.blobs.push(
                ...(data.layers || [])
                  .filter((layer) => !!layer.digest)
                  .map((layer) => ({
                    ...layer,
                    platform,
                    url: registryUrl(registry, namespace, name, layer.digest!, 'blobs'),
                  }))
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
          const blobs: Transfer[] = [
            // First: Blobs
            ...fromImage.blobs.map((blob) => {
              const fromUrl = blob.url;
              const toUrl = fromUrl.replace(fromImage.registry, toImage.registry).replace(blob.digest!, `uploads/`);
              return new Transfer(
                this.api,
                fromUrl,
                toUrl,
                {
                  digest: blob.digest!,
                  mediaType: blob.mediaType!,
                  size: blob.size!,
                },
                () => {
                  toImage.blobs.push({ ...blob, url: toUrl });
                }
              );
            }),
          ];

          const images = fromImage.tags
            .map((tag) => [
              ...Object.entries(fromImage.images).map(([digest, manifest]) => {
                const fromUrl = registryUrl(
                  fromImage.registry,
                  fromImage.namespace,
                  fromImage.name,
                  digest,
                  'manifests'
                );
                const toUrl = registryUrl(
                  toImage.registry,
                  toImage.namespace,
                  toImage.name,
                  `${tag}-${digest.replace('sha256:', '').slice(0, 8)}`,
                  'manifests'
                );
                return new Transfer(
                  this.api,
                  fromUrl,
                  toUrl,
                  {
                    digest,
                    mediaType: manifest.mediaType!,
                    size: manifest.size!,
                  },
                  () => {
                    toImage.images[digest] = manifest;
                  }
                );
              }),
            ])
            .flat();

          //TODO: index push still not happening
          //TODO: find out why errors aren't being reduced at the end
          const indexes = fromImage.tags.map(
            (tag) =>
              new Transfer(
                this.api,
                registryUrl(fromImage.registry, fromImage.namespace, fromImage.name, fromImage.reference, 'manifests'),
                registryUrl(toImage.registry, toImage.namespace, toImage.name, tag, 'manifests'),
                {
                  digest: fromImage.reference,
                  mediaType: fromImage.index.mediaType!,
                  size: fromImage.index.size!,
                },
                () => {
                  toImage.index = fromImage.index;
                }
              )
          );

          this.log.info(`Prepared transfers for image ${req.image}`, {
            blobs: blobs.length,
            images: images.length,
            indexes: indexes.length,
          });

          return { blobs, images, indexes };
          // TODO: handle 404 if namespace doesn't exist
          // TODO: clean up logging
        })
      )
      .pipe(Transfer.observeAll(ImageApi.CONCURRENCY, true)) // TODO: make verify optional
      .pipe(
        map((statuses) => {
          const response: ApiSchema<Image['Req'], Image['Res']> = {
            apiVersion: 'rowdy.run/v1alpha1',
            kind: 'Image',
            spec: req,
            status: {
              ...toImage,
              code: TransferStatus.code(statuses),
              reason: TransferStatus.reason(statuses),
            },
          };
          return response;
        }),
        tap((response) => {
          this.log.debug(`Image Spec`, JSON.stringify(response.spec));
          this.log.debug(`Image Status`, JSON.stringify(response.status));
          this.log.info(`Finished transferring image ${req.image} to ${response.status.registry}`, {
            status: response.status.code,
            reason: response.status.reason,
          });
        })
      );
  }
}

type Digest = string;
type TransferRef = Omit<Required<Image['External']['Ref']>, 'annotations'>;

class Transfer implements ILoggable {
  constructor(
    public api: IApi,
    public fromUrl: string,
    public toUrl: string,
    public ref: TransferRef,
    public finalizer: () => void
  ) {}

  static observeAll(
    concurrency: number,
    verify?: boolean
  ): OperatorFunction<{ blobs: Transfer[]; images: Transfer[]; indexes: Transfer[] }, Record<Digest, TransferStatus>> {
    return (source) =>
      source.pipe(
        switchMap(({ blobs, images, indexes }) =>
          concat(
            Transfer.observe(blobs, concurrency, verify),
            Transfer.observe(images, concurrency, verify),
            Transfer.observe(indexes, concurrency, verify)
          )
        ),
        reduce(
          (acc, cur) => {
            cur.finalize();
            acc[cur.digest] = cur;
            return acc;
          },
          {} as Record<Digest, TransferStatus>
        )
      );
  }

  private static observe(transfers: Transfer[], concurrency: number, verify?: boolean): Observable<TransferStatus> {
    return from(transfers).pipe(mergeMap((transfer) => transfer.pipe(verify), concurrency));
  }

  get log(): Logger {
    return this.api.log;
  }

  get http(): AxiosInstance {
    return this.api.http;
  }

  get digest(): string {
    return this.ref.digest;
  }

  get mediaType(): string {
    return this.ref.mediaType;
  }

  public pipe(verify?: boolean): Observable<TransferStatus> {
    return defer(async () => {
      const status = new TransferStatus(this);
      let chunked: boolean = false;
      let chunkSize = 10 * 1024 * 1024; // 10 MB
      let location: string = this.toUrl;

      this.log.debug('Starting transfer', { transfer: this });

      if (this.toUrl.endsWith('uploads/')) {
        // Uploads require a POST to get the Location header
        const start = await lastValueFrom(status.intercept(this.http.post(this.toUrl, null)));
        chunked = true;
        chunkSize = parseInt(start.headers['oci-chunk-min-length'] || chunkSize);
        const _location = start.headers['location'] || start.headers['Location'];
        if (_location) location = _location as string;
        this.log.info('Initialized upload', { transfer: this, location, chunkSize });
      }

      this.log.debug('Downloading', { transfer: this });
      const download = await lastValueFrom(
        status.intercept(
          this.http.get<Readable>(this.fromUrl, {
            responseType: 'stream',
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            headers: { Accept: this.mediaType },
          })
        )
      );

      const chunks = new Observable<{ chunk: Buffer; final: boolean }>((subscriber) => {
        let buffer = Buffer.alloc(0);

        if (!download.data.on) {
          this.log.warn(`No data stream available for download`, { transfer: this });
          subscriber.complete();
          return;
        }

        download.data.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (!chunked) {
            return;
          }

          if (buffer.length < chunkSize) {
            return;
          }

          let upload = buffer;
          buffer = Buffer.alloc(0);

          subscriber.next({ chunk: upload, final: false });
        });

        download.data.on('end', () => {
          if (buffer.length) {
            subscriber.next({ chunk: buffer, final: true });
          }
          subscriber.complete();
        });

        download.data.on('error', (err) => subscriber.error(err));
      });

      if (!chunked) {
        this.log.debug(`Uploading single chunk`, { digest: this.digest, url: location, mediaType: this.mediaType });
        const data = await lastValueFrom(chunks);
        const final = await lastValueFrom(
          status.withResponse(this.http.put(location, data.chunk, { headers: { 'Content-Type': this.mediaType } }))
        );
        return final;
      }

      const final = await lastValueFrom(
        status.withResponse(
          lastValueFrom(
            chunks.pipe(
              concatMap(({ chunk, final }) => {
                const url = final ? `${location}?digest=${this.digest}` : location;
                this.log.debug(`Uploading ${chunk.length} bytes`, { digest: this.digest, url, final });
                return from(
                  status.intercept(
                    this.http.patch(url, chunk, {
                      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': chunk.length },
                    })
                  )
                ).pipe(
                  concatMap((response) => {
                    if (final) {
                      this.log.debug(`Finalizing`, { digest: this.digest, location });
                      return from(this.http.put(`${location}?digest=${this.digest}`, null));
                    }
                    const _location = response.headers['location'] || response.headers['Location'];
                    if (_location) location = _location as string;
                    return of(response);
                  })
                );
              })
            )
          )
        )
      );

      return final;
    }).pipe(
      switchMap((status) => (verify ? status.verify() : of(status))),
      tap((status) => this.log.debug(`Transfer complete`, { status }))
    );
  }

  repr(): string {
    return `Transfer(from=${this.fromUrl}, to=${this.toUrl}, digest=${this.digest}, mediaType=${this.mediaType})`;
  }
}

class TransferStatus implements ILoggable {
  static code(statuses: Record<Digest, TransferStatus>): number {
    const failed = Object.values(statuses).find((s) => s.failed);
    return failed ? 206 : 200;
  }

  static reason(statuses: Record<Digest, TransferStatus>): string | undefined {
    const failures = Object.values(statuses).filter((s) => s.failed);
    if (!failures.length) {
      return undefined;
    }
    return failures
      .map((s) => s._reasons)
      .flat()
      .join(', ');
  }

  private _codes: number[] = [];
  private _reasons: string[] = [];

  constructor(private transfer: Transfer) {}

  get log(): Logger {
    return this.transfer.api.log;
  }

  get http(): AxiosInstance {
    return this.transfer.http;
  }

  get url(): string {
    if (this.transfer.toUrl.endsWith('blobs/uploads/')) {
      return this.transfer.toUrl.replace('blobs/uploads/', `blobs/${this.transfer.digest}`);
    }
    return this.transfer.toUrl;
  }

  get digest(): string {
    return this.transfer.ref.digest;
  }

  get mediaType(): string {
    return this.transfer.ref.mediaType;
  }

  get failed(): boolean {
    return this._codes.some((c) => c >= 400);
  }

  intercept<T, D, H>(response: Promise<AxiosResponse<T, D, H>>): Observable<AxiosResponse<Partial<T>, D, H>> {
    return defer(() => from(response)).pipe(
      map((res) => {
        this._codes.push(res.status);
        this._reasons.push(this.reason(res));
        return res as AxiosResponse<Partial<T>, D, H>;
      }),
      catchError((err) => {
        this.log.warn(`Transfer error`, { error: err, transfer: this.transfer });
        if (!isAxiosError(err)) {
          return throwError(() => err);
        }
        this._codes.push(err.response?.status || 500);
        this._reasons.push(this.reason(err.response!));
        return of(err.response! as AxiosResponse<Partial<T>, D, H>);
      })
    );
  }

  withResponse<T, D, H>(response: Promise<AxiosResponse<T, D, H>>): Observable<this> {
    return this.intercept(response).pipe(map(() => this));
  }

  verify(): Observable<this> {
    return defer(() => this.http.head(this.url)).pipe(
      retry({
        count: 3,
        delay: (_, retryCount) => timer(Math.pow(2, retryCount) * 1000),
        resetOnSuccess: true,
      }),
      map(() => {
        this.log.debug(`Transfer verified`, { digest: this.digest, url: this.url });
        return this;
      }),
      catchError((err) => {
        if (!isAxiosError(err)) {
          return throwError(() => err);
        }

        const reason = this.reason(err.response!);
        this._codes.push(err.response?.status || 500);
        this._reasons.push(reason);
        this.log.warn(`Transfer verification failed`, { digest: this.digest, url: this.url, reason });

        return of(this);
      })
    );
  }

  finalize(): void {
    return this.transfer.finalizer();
  }

  private reason<T, D, H>(response: AxiosResponse<T, D, H>): string {
    return `[${this.transfer.mediaType}] ${response.status} ${response.statusText}: ${response.config.method?.toUpperCase()} ${response.config.url}`;
  }

  repr(): string {
    return `TransferStatus(digest=${this.digest}, mediaType=${this.mediaType}, success=${!this.failed}, url=${this.url})`;
  }
}
