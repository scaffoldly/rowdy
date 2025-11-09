import {
  catchError,
  concatMap,
  defer,
  from,
  map,
  mergeMap,
  NEVER,
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
import { HttpHeaders } from '../../proxy/http';
import { createHash } from 'crypto';
import { ILoggable, Logger } from '../../log';
import { AxiosInstance, AxiosResponse, isAxiosError } from 'axios';
import { TRegistry } from '../types';
import { cpus } from 'os';
import { Readable } from 'stream';

export type External = {
  Ref: Partial<{
    mediaType: string;
    size: number;
    digest: string;
    annotations: Record<string, string>;
  }>;
  Index: Partial<{
    schemaVersion: number;
    mediaType: 'application/vnd.oci.image.index.v1+json' | 'application/vnd.docker.distribution.manifest.list.v2+json';
    manifests: External['Manifest'][];
  }>;
  Manifest: External['Ref'] & Partial<{ platform: Partial<{ architecture: string; os: string }> }>;
  ImageManifest: Partial<{
    schemaVersion: number;
    mediaType: 'application/vnd.oci.image.manifest.v1+json' | 'application/vnd.docker.distribution.manifest.v2+json';
    config: External['Ref'];
    layers: External['Ref'][];
  }>;
  Config: External['Ref'];
  Layer: External['Ref'];
};

export type Image = {
  registry: string;
  slug: string;
  namespace: string;
  name: string;
  image: string;
  digest: string;
  tag: string | null;
  url: string;
  authorization?: string | undefined;
};

export type ImageManifest = Image & {
  index: External['Index'];
  images: External['ImageManifest'][];
  headers: HttpHeaders;
};

export type ImageManifestTransfers = ImageManifest & {
  blobs: Upload[];
  images: Upload[];
  indexes: Upload[];
};

type Response<T> = { data: T | undefined; headers: HttpHeaders; status: number; method: string; url: string };

export class Transfer {
  private static _CONCURRENCY = {
    MIN: 1,
    MAX: 10,
    CURRENT: 0,
  };

  static get CONCURRENCY(): number {
    if (Transfer._CONCURRENCY.CURRENT === 0) {
      const num = cpus()?.length || Transfer._CONCURRENCY.MIN;
      // Use all of the possible CPUs, up to MAX
      Transfer._CONCURRENCY.CURRENT = Math.min(Math.max(Transfer._CONCURRENCY.MIN, num), Transfer._CONCURRENCY.MAX);
    }
    return Transfer._CONCURRENCY.CURRENT;
  }

  private _uploads: Upload[][] = [];

  private constructor(
    public readonly log: Logger,
    public readonly http: AxiosInstance,
    public readonly manifest: ImageManifest,
    public readonly registry: TRegistry
  ) {}

  private with(uploads: Upload[]): this {
    if (!uploads.length) {
      return this;
    }
    this._uploads.push(uploads);
    return this;
  }

  get uploads(): Observable<Upload[]> {
    return of(this._uploads).pipe(concatMap((u) => from(u)));
  }

  static normalize(authorization?: string, registry: string = 'registry-1.docker.io'): OperatorFunction<string, Image> {
    return (source) =>
      source.pipe(
        map((image) => {
          const parts = image.split('/');
          if (parts.length > 2) {
            registry = parts[0] || registry;
          }

          let [nameAndTag = '', namespace = 'library'] = [...parts].reverse();
          let [name, digest = 'latest', tag = null] = nameAndTag.split(':');

          if (name?.endsWith('@sha256')) {
            [name, digest = digest] = nameAndTag.split('@');
            tag = null;
          } else {
            tag = digest;
          }

          if (!name) {
            throw new Error(`Unable to normalize image: ${image}`);
          }

          if (parts.length <= 2) {
            image = `${registry}/${namespace}/${name}${tag ? `:${tag}` : `@${digest}`}`;
          }

          let slug = `${namespace}/${name}`;
          if (parts.length > 3) {
            slug = `${[...parts].slice(1, -1).join('/')}/${name}`;
          }

          let url = `https://${registry}/v2/${slug}/manifests/${digest}`;

          const result: Image = {
            registry: registry!,
            slug,
            name,
            namespace,
            image,
            digest,
            tag,
            url,
            authorization,
          };

          return result;
        })
      );
  }

  static collect(log: Logger, http: AxiosInstance): OperatorFunction<Image, ImageManifest> {
    const headers: HttpHeaders = HttpHeaders.from({
      Accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ],
    });

    return (source) => {
      return source.pipe(
        tap((image) => log.info(`${image.image}: Pulling from ${image.slug}`)),
        switchMap((image) => {
          return from(
            http.get<External['Index']>(image.url, {
              headers: headers.override('authorization', image.authorization).intoAxios(),
            })
          ).pipe(
            map(({ headers, data }) => {
              if (data.schemaVersion !== 2) {
                throw new Error(`Unsupported schemaVersion on index: ${data.schemaVersion}`);
              }

              if (
                data.mediaType !== 'application/vnd.oci.image.index.v1+json' &&
                data.mediaType !== 'application/vnd.docker.distribution.manifest.list.v2+json'
              ) {
                throw new Error(`Unsupported mediaType on index: ${data.mediaType}`);
              }

              if (headers['docker-content-digest']) {
                return { digest: headers['docker-content-digest'] as string, index: data };
              }
              return {
                digest: `sha256:${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`,
                index: data,
              };
            }),
            switchMap(({ digest, index }) =>
              from(index.manifests || [])
                .pipe(
                  tap((manifest) =>
                    log.info(`${image.registry}/${image.slug}@${manifest.digest}: Pulling from ${image.slug}`)
                  ),
                  map((manifest) => `${image.url.split('/').slice(0, -1).join('/')}/${manifest.digest}`),
                  tap((url) => log.info(`Fetching manifest from URL: ${url}`)),
                  mergeMap(
                    (url) =>
                      from(http.get<External['ImageManifest']>(url, { headers: headers.intoAxios() })).pipe(
                        map(({ data }) => {
                          if (data.schemaVersion !== 2) {
                            throw new Error(`Unsupported schemaVersion on manifest: ${data.schemaVersion}`);
                          }

                          if (
                            data.mediaType !== 'application/vnd.oci.image.manifest.v1+json' &&
                            data.mediaType !== 'application/vnd.docker.distribution.manifest.v2+json'
                          ) {
                            throw new Error(`Unsupported mediaType on manifest: ${data.mediaType}`);
                          }

                          return data;
                        })
                      ),
                    Transfer.CONCURRENCY
                  ),
                  toArray()
                )
                .pipe(map((images) => ({ digest, index, images })))
            ),
            tap(({ digest }) => log.info(`Digest: ${digest}`)),
            map(({ digest, index, images }) => {
              // Make sure data types line up
              const result: ImageManifest = {
                ...image,
                digest,
                index,
                images,
                headers,
              };
              return result;
            })
          );
        })
      );
    };
  }

  static prepare(
    log: Logger,
    http: AxiosInstance,
    registry: Observable<TRegistry>
  ): OperatorFunction<ImageManifest, Transfer> {
    return (source) =>
      source.pipe(
        switchMap((manifest) =>
          registry.pipe(
            switchMap((registry) => registry.withSlug(manifest.slug)),
            map((registry) => {
              return new Transfer(log, http, manifest, registry);
            })
          )
        ),
        map((transfer) =>
          transfer
            .with(
              transfer.manifest.images
                .map((img) => [img.config || {}, ...(img.layers || [])])
                .flatMap((refs) => refs.filter((r): r is Required<External['Ref']> => !!r.digest && !!r.mediaType))
                .map((ref) => new Upload(transfer, 'blob', ref))
            )
            .with(
              (transfer.manifest.index.manifests || [])
                .filter((m): m is Required<External['Ref']> => !!m.digest && !!m.mediaType)
                .map((manifest) => new Upload(transfer, 'manifest', manifest))
            )
            .with([
              new Upload(transfer, 'manifest', {
                digest: transfer.manifest.tag
                  ? transfer.manifest.tag
                  : `untagged-${transfer.manifest.digest.replace('sha256:', '').slice(0, 12)}`,
                mediaType: transfer.manifest.index.mediaType!,
                size: 0,
              }),
            ])
        )
      );
  }

  static upload(log: Logger, _http: AxiosInstance): OperatorFunction<Transfer, TransferStatus> {
    const summary = (transfers: Transfer): string => {
      const uploads = transfers._uploads.flat();
      const totalTransfers = uploads.length;
      const completedTransfers = uploads.filter((u) => u.complete).length;

      const totalBytes = uploads.reduce((acc, upload) => acc + upload.bytesTotal, 0);
      const completedBytes = uploads.reduce((acc, upload) => acc + upload.bytesSent, 0);

      const transferRatio = `${completedTransfers}/${totalTransfers}`;
      const pct = totalBytes === 0 ? '100%' : `${((completedBytes / totalBytes) * 100).toFixed(0)}%`;
      return `${transferRatio} transfers: ${pct} complete`;
    };

    return (source) =>
      new Observable((subscriber) => {
        const status = new TransferStatus();

        let latest: Transfer | undefined = undefined;
        const proc = setInterval(() => {
          if (latest) log.info(`Upload progress: ${summary(latest)}`);
        }, 1000);

        const subscription = source
          .pipe(
            tap((transfer) => (latest = transfer)),
            concatMap((transfer) => from(transfer.uploads)),
            concatMap((uploads) => Upload.observe(uploads, Transfer.CONCURRENCY)),
            reduce((acc, cur) => {
              cur.finalize();
              return acc.withStatus(cur);
            }, status)
          )
          .subscribe(subscriber);

        return () => {
          if (latest) log.info(`Transfer complete: ${summary(latest)}`);
          subscription.unsubscribe();
          clearInterval(proc);
        };
      });
  }

  static denormalize(): OperatorFunction<TransferStatus, string> {
    return (source) => source.pipe(map(({ imageRef }) => imageRef));
  }
}

export class TransferStatus implements ILoggable {
  private _transfer: Transfer | undefined = undefined;
  private _statuses: UploadStatus[] = [];

  constructor() {}

  withTransfer(transfer: Transfer): this {
    if (this._transfer) {
      throw new Error('Transfer already set on TransferStatus');
    }
    this._transfer = transfer;
    return this;
  }

  withStatus(status: UploadStatus): this {
    this._statuses.push(status);
    return this;
  }

  get image(): string {
    if (!this._transfer) {
      throw new Error('Transfer has not been initialized');
    }
    return this._transfer.manifest.image;
  }

  get imageRef(): string {
    const last = this._statuses.slice(-1)[0];
    if (!last) {
      throw new Error('No uploads have occurred');
    }
    try {
      return last.imageRef;
    } catch {
      throw new Error(`Transfer failed:\n${this.reasons.join('\n\t')}`);
    }
  }

  get code(): number {
    const failed = Object.values(this._statuses).find((s) => s.failed);
    return failed ? 206 : 200;
  }

  get reasons(): string[] {
    const failures = Object.values(this._statuses).filter((s) => s.failed);
    if (!failures.length) {
      return [];
    }
    return failures.map((s) => s.reasons).flat();
  }

  repr(): string {
    return `TransferStatus()`;
  }
}

export class Upload implements ILoggable {
  private _complete: boolean = false;
  private bytes: { received: number; sent: number; total: number };

  constructor(
    public readonly transfer: Transfer,
    public readonly type: 'blob' | 'manifest',
    public readonly ref: Omit<Required<External['Ref']>, 'annotations'>
  ) {
    this.bytes = {
      received: 0,
      sent: 0,
      total: ref.size,
    };
  }

  finalizer(): void {
    // TODO: implement finalizer if necesary
  }

  get log(): Logger {
    return this.transfer.log;
  }

  get http(): AxiosInstance {
    return this.transfer.http;
  }

  get complete(): boolean {
    return this._complete;
  }

  get bytesSent(): number {
    return this.bytes.sent;
  }

  get bytesTotal(): number {
    return this.bytes.total;
  }

  get fromUrl(): string {
    const { url } = this.transfer.manifest;
    if (this.type === 'blob') {
      return url.split('/').slice(0, -2).join('/') + `/blobs/${this.ref.digest}`;
    }
    return url.split('/').slice(0, -2).join('/') + `/manifests/${this.ref.digest}`;
  }

  get toUrl(): string {
    // eslint-disable-next-line no-restricted-globals
    const url = new URL(this.fromUrl);
    url.host = this.transfer.registry.registry;
    url.pathname = url.pathname.replace(
      this.transfer.manifest.slug,
      `${this.transfer.manifest.namespace}/${this.transfer.manifest.name}`
    );
    if (this.type === 'blob') {
      url.pathname = url.pathname.replace(/blobs\/.*/, 'blobs/uploads/');
    }
    return url.toString();
  }

  get digest(): string {
    return this.ref.digest;
  }

  get mediaType(): string {
    return this.ref.mediaType;
  }

  static observe(uplods: Upload[], concurrency: number, _verify?: boolean): Observable<UploadStatus> {
    // return from(uplods).pipe(mergeMap((upload) => upload.pipe(verify), concurrency));
    return from(uplods).pipe(mergeMap((upload) => upload.upload(), concurrency));
  }

  private async upload(): Promise<UploadStatus> {
    const status = new UploadStatus(this);
    const fromUrl = this.fromUrl;
    let toUrl = this.toUrl;

    if (this.type === 'blob') {
      const location = await this.http
        .post(toUrl, null, { headers: { 'Content-Type': this.mediaType } })
        .then((res) => res.headers['location'] as string | undefined);

      if (!location) {
        throw new Error(`No location header received`);
      }

      toUrl = location;
    }

    let { data: download } = await this.http.get<Readable>(fromUrl, {
      responseType: 'stream',
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      headers: { Accept: this.mediaType },
      onDownloadProgress: (e) => (this.bytes.received += e.bytes),
    });

    if (this.type === 'blob') {
      await this.http.patch(toUrl, download, {
        headers: { 'Content-Type': 'application/octet-stream' },
        onUploadProgress: (e) => (this.bytes.sent += e.bytes),
      });
      toUrl = `${toUrl}?digest=${this.digest}`;
      download = Readable.from('');
    }

    await this.http.put(toUrl, download, {
      headers: {
        'Content-Type': this.mediaType,
      },
      onUploadProgress: (e) => (this.bytes.sent += e.bytes),
    });

    this._complete = true;
    return status;
  }

  public pipe(_verify?: boolean): Observable<UploadStatus> {
    return NEVER;
    // const fromUrl = this.fromUrl;
    // let toUrl = this.toUrl;
    // if (this.type === 'blob') {
    // }
    // return defer(async () => {
    //   const status = new UploadStatus(this);
    //   let chunked: boolean = false;
    //   let chunkSize = 10 * 1024 * 1024; // 10 MB
    //   let location: string = this.toUrl;
    //   this.log.debug('Starting transfer', { transfer: this });
    //   if (this.type === 'blob') {
    //     // Uploads require a POST to get the Location header
    //     const start = await lastValueFrom(
    //       status.intercept(this.http.post(this.toUrl, null, { headers: { 'Content-Type': this.mediaType } }))
    //     );
    //     const _location = start.headers.get('location');
    //     chunked = true;
    //     chunkSize = parseInt((start.headers.get('oci-chunk-min-length') as string | undefined) || `${chunkSize}`, 10);
    //     if (_location) location = _location as string;
    //     this.log.debug('Initialized upload', { transfer: this, location, chunkSize });
    //   }
    //   this.log.debug('Downloading', { transfer: this });
    //   const download = await lastValueFrom(
    //     status.intercept(
    //       this.http.get<Readable>(this.fromUrl, {
    //         responseType: 'stream',
    //         maxBodyLength: Infinity,
    //         maxContentLength: Infinity,
    //         headers: { Accept: this.mediaType },
    //       })
    //     )
    //   );
    //   const data$ = new Observable<Buffer>((subscriber) => {
    //     let buffer = Buffer.alloc(0);
    //     if (!download.data) {
    //       subscriber.error(new Error('No data stream available for download'));
    //       return;
    //     }
    //     download.data.on('data', (chunk: Buffer) => {
    //       buffer = Buffer.concat([buffer, chunk]);
    //       if (!chunked) {
    //         return;
    //       }
    //       if (buffer.length < chunkSize) {
    //         return;
    //       }
    //       const upload = buffer;
    //       buffer = Buffer.alloc(0);
    //       subscriber.next(upload);
    //     });
    //     download.data.on('end', () => {
    //       subscriber.next(buffer);
    //       subscriber.complete();
    //     });
    //     download.data.on('error', (err) => subscriber.error(err));
    //   });
    //   const uploaded = chunked
    //     ? data$.pipe(
    //         tap((data) => {
    //           this.bytes.received += data.length;
    //           this.log.debug('Uploading chunk', { digest: this.digest, location, chunkSize: data.length });
    //         }),
    //         concatMap((data) =>
    //           status
    //             .intercept(
    //               this.http.patch(location, data, {
    //                 headers: { 'Content-Type': 'application/octet-stream' },
    //               })
    //             )
    //             .pipe(
    //               tap(() => {
    //                 this.bytes.sent += data.length;
    //                 this.log.debug('Uploaded chunk', { digest: this.digest, location, chunkSize: data.length });
    //               })
    //             )
    //         ),
    //         toArray(),
    //         switchMap(() =>
    //           status.withResponse(this.http.put(`${location}?digest=${this.digest}`, null, {})).pipe(
    //             tap(() => {
    //               this.log.debug('Finalized upload', { digest: this.digest, location });
    //             })
    //           )
    //         )
    //       )
    //     : data$.pipe(
    //         tap((data) => {
    //           this.bytes.received += data.length;
    //           this.log.debug('Uploading single chunk', { digest: this.digest, location, chunkSize: data.length });
    //         }),
    //         switchMap((data) =>
    //           status
    //             .withResponse(
    //               this.http.put(location, data, {
    //                 headers: { 'Content-Type': this.mediaType },
    //               })
    //             )
    //             .pipe(
    //               tap(() => {
    //                 this.bytes.sent += data.length;
    //                 this.log.debug('Uploaded single chunk', {
    //                   digest: this.digest,
    //                   location,
    //                   chunkSize: data.length,
    //                 });
    //               })
    //             )
    //         )
    //       );
    //   this._complete = true;
    //   return lastValueFrom(uploaded);
    // }).pipe(
    //   tap((status) => {
    //     this._complete = true;
    //     return status;
    //   })
    // );
  }

  repr(): string {
    return `Upload(from=${this.fromUrl}, to=${this.toUrl}, digest=${this.digest}, mediaType=${this.mediaType})`;
  }
}

class UploadStatus implements ILoggable {
  private verified: boolean = false;
  private _codes: number[] = [];
  private _reasons: string[] = [];

  constructor(private upload: Upload) {}

  get imageRef(): string {
    if (this.failed) {
      throw new Error(`Upload failed: ${this.reasons.join('; ')}`);
    }
    const { digest, namespace, name } = this.upload.transfer.manifest;
    return `${this.upload.transfer.registry.registry}/${namespace}/${name}@${digest}`;
  }

  get log(): Logger {
    return this.upload.log;
  }

  get http(): AxiosInstance {
    return this.upload.http;
  }

  get url(): string {
    if (this.upload.toUrl.endsWith('blobs/uploads/')) {
      return this.upload.toUrl.replace('blobs/uploads/', `blobs/${this.upload.digest}`);
    }
    return this.upload.toUrl;
  }

  get digest(): string {
    return this.upload.digest;
  }

  get mediaType(): string {
    return this.upload.mediaType;
  }

  get failed(): boolean {
    return this._codes.some((c) => c >= 400);
  }

  get reasons(): string[] {
    return this._reasons;
  }

  intercept<T>(response: Promise<AxiosResponse<T>>): Observable<Response<T>> {
    return defer(() => from(response)).pipe(
      map((res) => {
        this._codes.push(res.status);
        this._reasons.push(this.reason(res));
        return {
          data: res.data,
          headers: HttpHeaders.fromAxios(res.headers),
          status: res.status,
          method: res.config.method!,
          url: res.config.url!,
        };
      }),
      catchError((err) => {
        this.log.warn(`Upload error`, { error: err, transfer: this.upload });
        if (!isAxiosError(err)) {
          return throwError(() => err);
        }
        this._codes.push(err.response?.status || 500);
        this._reasons.push(this.reason(err.response!));
        return of({
          data: undefined,
          headers: HttpHeaders.fromAxios(err.response?.headers || {}),
          status: err.response?.status || 500,
          method: err.config!.method!,
          url: err.config!.url!,
        });
      })
    );
  }

  withResponse<T>(response: Promise<AxiosResponse<T>>): Observable<this> {
    return this.intercept(response).pipe(map(() => this));
  }

  verify(): Observable<this> {
    if (this.verified) {
      return of(this);
    }

    return defer(() => this.http.head(this.url)).pipe(
      retry({
        count: 3,
        delay: (_, retryCount) => timer(Math.pow(2, retryCount) * 1000),
        resetOnSuccess: true,
      }),
      map(() => {
        this.log.debug(`Transfer verified`, { digest: this.digest, url: this.url });
        this.verified = true;
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
    if (this.failed) {
      return;
    }
    return this.upload.finalizer();
  }

  private reason<T>(response: AxiosResponse<T>): string {
    return `[${this.upload.mediaType}] HTTP ${response.status}: ${response.config.method?.toUpperCase()} ${response.config.url}`;
  }

  repr(): string {
    return `UploadStatus(digest=${this.digest}, mediaType=${this.mediaType}, url=${this.url}, verified=${this.verified})`;
  }
}
