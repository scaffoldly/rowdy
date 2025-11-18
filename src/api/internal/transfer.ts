import {
  catchError,
  concatMap,
  defer,
  from,
  map,
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
import { HttpHeaders } from '../../proxy/http';
import { createHash } from 'crypto';
import { ILoggable, Logger } from '../../log';
import { AxiosInstance, AxiosResponse, isAxiosError } from 'axios';
import { PullImageOptions, TRegistry } from '../types';
import { cpus } from 'os';
import { Readable } from 'stream';
import promiseRetry from 'promise-retry';

export type External = {
  Ref: Partial<{
    mediaType: string;
    size: number;
    digest: string;
    annotations?: Record<string, string>;
  }>;
  Index: Partial<{
    schemaVersion: number;
    mediaType: 'application/vnd.oci.image.index.v1+json' | 'application/vnd.docker.distribution.manifest.list.v2+json';
    manifests: External['Manifest'][];
  }>;
  Manifest: External['Ref'] & Partial<{ platform: Partial<{ architecture: string; os: string }> }>;
  Image: Partial<{
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
  images: { manifest: External['Manifest']; image: External['Image'] }[];
  headers: HttpHeaders;
};

type Response<T> = { data: T | undefined; headers: HttpHeaders; status: number; method: string; url: string };

export class Transfer implements ILoggable {
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

  get index(): External['Index'] {
    const index: External['Index'] = {
      schemaVersion: 2,
      mediaType: this.manifest.index.mediaType!,
      manifests: this.manifest.images.map((img) => {
        const content = JSON.stringify(img.image);
        const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
        return {
          ...img.manifest,
          digest,
          size: content.length,
        };
      }),
    };
    return index;
  }

  get uploads(): Observable<Upload[]> {
    return of(this._uploads).pipe(concatMap((u) => from(u)));
  }

  static normalizeImage(image?: string, authorization?: string, registry: string = 'mirror.gcr.io'): Image {
    if (!image) {
      throw new Error('Image is required');
    }

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
  }

  static normalize(authorization?: string, registry?: string): OperatorFunction<string, Image> {
    return (source) => source.pipe(map((image) => this.normalizeImage(image, authorization, registry)));
  }

  static collect(log: Logger, http: AxiosInstance, layersFrom?: string): OperatorFunction<Image, ImageManifest> {
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
          if (!layersFrom) {
            return of({ image, additional: undefined });
          }
          return of(layersFrom).pipe(
            Transfer.normalize(),
            Transfer.collect(log, http),
            map((manifest) => ({ image, additional: manifest }))
          );
        }),
        switchMap(({ image, additional }) => {
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

              if (additional) {
                // Drop attestation manifests, since we're fundamentally altering the image with new layers
                data.manifests = data.manifests?.filter((m) => m.platform?.architecture !== 'unknown');
              }

              const digest = headers['docker-content-digest'];
              if (!digest) {
                throw new Error(`No docker-content-digest header found on response for ${image.url}`);
              }

              return {
                digest,
                index: data,
                additional,
              };
            }),
            switchMap(({ digest, index, additional }) =>
              from(index.manifests || [])
                .pipe(
                  tap((manifest) =>
                    log.info(`${image.registry}/${image.slug}@${manifest.digest}: Pulling from ${image.slug}`)
                  ),
                  map((manifest) => ({
                    manifest,
                    url: `${image.url.split('/').slice(0, -1).join('/')}/${manifest.digest}`,
                  })),
                  tap(({ url }) => log.debug(`Fetching manifest from URL: ${url}`)),
                  mergeMap(
                    ({ manifest, url }) =>
                      from(http.get<External['Image']>(url, { headers: headers.intoAxios() })).pipe(
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

                          const match = additional?.index?.manifests?.find(
                            (m) =>
                              m.platform?.architecture === manifest.platform?.architecture &&
                              m.platform?.os === manifest.platform?.os
                          );

                          if (match) {
                            data.layers = data.layers || [];
                            data.layers.push(
                              ...(
                                additional?.images?.find((img) => img.manifest.digest === match.digest)?.image.layers ||
                                []
                              ).map((l) => ({
                                ...l,
                                annotations: { ...l.annotations, 'run.rowdy.index.url': additional!.url },
                              }))
                            );
                          }

                          return {
                            manifest: manifest,
                            image: data,
                          };
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
                .map((img) => img.image.config)
                .filter((c): c is Required<External['Ref']> => !!c && !!c.digest && !!c.mediaType)
                .map((ref) => new Upload(transfer, 'blob', ref))
            )
            .with(
              transfer.manifest.images
                .flatMap((img) => img.image.layers)
                .filter((l): l is Required<External['Ref']> => !!l && !!l.digest && !!l.mediaType)
                .map((ref) => new Upload(transfer, 'blob', ref))
            )
            .with(
              (transfer.manifest.images || []).map((img) => {
                // Compute the correct digest from the actual content
                const content = JSON.stringify(img.image);
                const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
                return new Upload(
                  transfer,
                  'manifest',
                  {
                    digest,
                    mediaType: img.manifest.mediaType!,
                    size: content.length,
                  },
                  Readable.from(content)
                );
              })
            )
            .with([
              new Upload(
                transfer,
                'manifest',
                {
                  digest: transfer.manifest.tag
                    ? transfer.manifest.tag
                    : `untagged-${transfer.manifest.digest.replace('sha256:', '').slice(0, 12)}`,
                  mediaType: transfer.manifest.index.mediaType!,
                  size: 0,
                },
                Readable.from(JSON.stringify(transfer.index))
              ),
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
        // TODO: add transfer to constructor and remove withTransfer
        const status = new TransferStatus();

        let latest: Transfer | undefined = undefined;
        const proc = setInterval(() => {
          if (latest) log.info(`Upload progress: ${summary(latest)}`);
        }, 1000);

        const subscription = source
          .pipe(
            tap((transfer) => {
              status.withTransfer(transfer);
              latest = transfer;
            }),
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

  // TODO: Support for platform annotation
  static denormalize(platform: PullImageOptions['platform'] = 'linux/amd64'): OperatorFunction<TransferStatus, string> {
    return (source) =>
      source.pipe(
        map((status) => {
          const [os, architecture] = platform.split('/');

          const digest = status.index.manifests?.find(
            (m) => m.platform?.os === os && m.platform?.architecture === architecture
          )?.digest;

          if (!digest) {
            throw new Error(`Unable to find image for platform: ${platform}`);
          }

          return status.imageRef(digest);
        })
      );
  }

  repr(): string {
    return `Transfer()`;
  }
}

export class TransferStatus implements ILoggable {
  private _transfer?: Transfer;
  private _statuses: UploadStatus[] = [];

  constructor() {}

  withTransfer(transfer: Transfer): this {
    this._transfer = transfer;
    return this;
  }

  withStatus(status: UploadStatus): this {
    this._statuses.push(status);
    return this;
  }

  get index(): External['Index'] {
    if (!this._transfer) {
      throw new Error('No transfer associated with this status');
    }
    return this._transfer.index;
  }

  imageRef(digest?: string): string {
    const desired = this._statuses.find((s) => s.digest === digest) || this._statuses.slice(-1)[0];
    if (!desired) {
      throw new Error(`Unable to find status for digest: ${digest}`);
    }

    const { namespace, name } = this._transfer?.manifest || {};
    const { registry } = this._transfer?.registry || {};

    if (!registry || !namespace || !name) {
      throw new Error('Incomplete transfer information to construct image ref');
    }

    let tag = desired.digest.startsWith('sha256:') ? `@${desired.digest}` : `:${desired.digest}`;
    return `${registry}/${namespace}/${name}${tag}`;
  }

  get code(): number {
    const failed = Object.values(this._statuses).filter((s) => s.failed);
    return failed.length ? 206 : 200;
  }

  get reasons(): string[] {
    const failures = Object.values(this._statuses).filter((s) => s.failed);
    if (!failures.length) {
      return [];
    }
    return failures.map((s) => s.reasons).flat();
  }

  repr(): string {
    return `TransferStatus(Transfer=${this._transfer?.repr()})`;
  }
}

export class Upload implements ILoggable {
  private _complete: boolean = false;
  private bytes: { received: number; sent: number; total: number };
  private _from?: { url: string };

  constructor(
    public readonly transfer: Transfer,
    public readonly type: 'blob' | 'manifest',
    public readonly ref: External['Ref'],
    public readonly content?: Readable
  ) {
    this.bytes = {
      received: 0,
      sent: 0,
      total: ref.size || 0,
    };

    this._from = ref.annotations?.['run.rowdy.index.url'] ? { url: ref.annotations['run.rowdy.index.url'] } : undefined;
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
    const { url } = this._from || this.transfer.manifest;
    if (this.type === 'blob') {
      return url.split('/').slice(0, -2).join('/') + `/blobs/${this.ref.digest}`;
    }
    return url.split('/').slice(0, -2).join('/') + `/manifests/${this.ref.digest}`;
  }

  get verifyUrl(): string {
    // eslint-disable-next-line no-restricted-globals
    const url = new URL(this.fromUrl);
    url.host = this.transfer.registry.registry;
    const match = url.pathname.match(/v2\/(.*)\/(blobs|manifests)\/(.*)/);
    if (!match) {
      throw new Error(`Unable to parse upload URL: ${url.toString()}`);
    }
    url.pathname = `/v2/${this.transfer.manifest.namespace}/${this.transfer.manifest.name}/${match[2]}/${match[3]}`;
    return url.toString();
  }

  get toUrl(): string {
    // eslint-disable-next-line no-restricted-globals
    const url = new URL(this.verifyUrl);
    if (this.type === 'blob') {
      url.pathname = url.pathname.replace(/blobs\/.*/, 'blobs/uploads/');
    }
    return url.toString();
  }

  get digest(): string {
    if (!this.ref.digest) {
      throw new Error('Upload ref has no digest');
    }
    return this.ref.digest;
  }

  get mediaType(): string {
    if (!this.ref.mediaType) {
      throw new Error('Upload ref has no mediaType');
    }
    return this.ref.mediaType;
  }

  static observe(uplods: Upload[], concurrency: number, _verify?: boolean): Observable<UploadStatus> {
    return from(uplods).pipe(mergeMap((upload) => upload.upload(), concurrency));
  }

  private upload(): Observable<UploadStatus> {
    return defer(async () => {
      const status = new UploadStatus(this);
      const fromUrl = this.fromUrl;
      let toUrl = this.toUrl;

      if (this.type === 'blob') {
        if (
          await promiseRetry(() =>
            status.intercept(
              this.http.head(this.verifyUrl, { validateStatus: (status) => [200, 404].includes(status) })
            )
          ).then(
            (res) =>
              res.status === 200 &&
              res.headers.get('content-length') == this.ref.size &&
              res.headers.get('docker-content-digest') === this.digest
          )
        ) {
          this.log.info(`${this.digest}: Layer exists, skipping upload`);
          this._complete = true;
          this.bytes.sent = this.bytes.total;
          return status;
        }

        const location = await promiseRetry(() =>
          status
            .intercept(this.http.post(toUrl, null, { headers: { 'Content-Type': this.mediaType } }))
            .then((res) => res.headers.get('location') as string | undefined)
        );

        if (!location) {
          throw new Error(`No location header received`);
        }

        toUrl = location;
      }

      let { data: download } =
        this.type === 'blob'
          ? await promiseRetry(() => {
              return status.intercept(
                this.http.get<Readable>(fromUrl, {
                  responseType: 'stream',
                  maxBodyLength: Infinity,
                  maxContentLength: Infinity,
                  headers: { Accept: this.mediaType },
                  onDownloadProgress: (e) => (this.bytes.received += e.bytes),
                })
              );
            })
          : { data: this.content };

      if (this.type === 'blob') {
        await promiseRetry(() => {
          return status.intercept(
            this.http.patch(toUrl, download, {
              headers: { 'Content-Type': 'application/octet-stream' },
              onUploadProgress: (e) => (this.bytes.sent += e.bytes),
            })
          );
        });
        toUrl = `${toUrl}?digest=${this.digest}`;
        download = Readable.from('');
      }

      await promiseRetry(() => {
        return status.intercept(
          this.http.put(toUrl, download, {
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            headers: {
              'Content-Type': this.mediaType,
            },
            onUploadProgress: (e) => (this.bytes.sent += e.bytes),
          })
        );
      });

      this._complete = true;
      return status;
    });
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

  async intercept<T>(response: Promise<AxiosResponse<T>>): Promise<Response<T>> {
    return response
      .then((res) => {
        this._reasons.push(this.reason(res));
        const response: Response<T> = {
          data: res.data,
          headers: HttpHeaders.fromAxios(res.headers),
          status: res.status,
          method: res.config.method?.toUpperCase() || 'UNKNOWN',
          url: res.config.url || 'UNKNOWN',
        };
        return response;
      })
      .catch((err) => {
        this.log.debug(`Upload error`, { error: err, transfer: this.upload });
        if (!isAxiosError(err)) {
          throw err;
        }
        this._codes.push(err.response?.status || 500);
        this._reasons.push(this.reason(err.response!));
        throw new Error(`Upload failed: ${this.reasons.reverse().join('\n\t')}`);
      });
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
