import { Observable, of } from 'rxjs';
import { AxiosInstance } from 'axios';
import { IApi, IImageApi, PulledImage } from './types';
import { Logger } from '../log';
import { Transfer } from './internal/transfer';

// TODO: rename to image

// const registryUrl = (
//   registry: string,
//   namespace: string,
//   name: string,
//   reference: string,
//   slug: 'manifests' | 'blobs'
// ): string => `https://${registry}/v2/${namespace}/${name}/${slug}/${reference}`;

export class ImageApi implements IImageApi {
  constructor(private api: IApi) {}

  get http(): AxiosInstance {
    return this.api.http;
  }

  get log(): Logger {
    return this.api.log;
  }

  pullImage(image: string, authorization?: string): Observable<PulledImage> {
    return of(image).pipe(
      Transfer.normalize(authorization),
      Transfer.collect(this.log, this.http),
      Transfer.prepare(this.log, this.http),
      Transfer.upload(this.log, this.http),
      Transfer.denormalize()
    );
  }

  // getImage(req: Image['Req'], opts?: Image['Opts']['GET']): Observable<ApiSchema<Image['Req'], Image['Res']>> {
  //   let { image } = req;
  //   if (typeof image === 'string') {
  //     image = image.split('/');
  //   }
  //   let registry: string | undefined = 'mirror.gcr.io';
  //   let namespace: string | undefined = 'library';
  //   let name: string | undefined = undefined;
  //   let reference = 'latest';

  //   if (image.length > 3) {
  //     return throwError(() => new Error(`Image name has too many segments`));
  //   }

  //   if (image.length === 3) {
  //     registry = image[0] || registry;
  //     namespace = image[1] || namespace;
  //     name = image[2];
  //   }

  //   if (image.length === 2) {
  //     registry = 'mirror.gcr.io';
  //     namespace = image[0] || namespace;
  //     name = image[1];
  //   }

  //   if (image.length === 1) {
  //     registry = 'mirror.gcr.io';
  //     namespace = 'library';
  //     name = image[0];
  //   }

  //   if (name?.includes('@sha256:')) {
  //     [name, reference = ''] = name.split('@sha256:');
  //     if (!reference) {
  //       return throwError(() => new Error('Invalid image name'));
  //     }
  //     reference = `sha256:${reference}`;
  //   }

  //   if (!reference.startsWith('sha256:') && name?.includes(':')) {
  //     [name, reference = 'latest'] = name.split(':');
  //   }

  //   if (!name) {
  //     return throwError(() => new Error('Invalid image name'));
  //   }

  //   req.image = `${registry}/${namespace}/${name}:${reference}`;

  //   const res: Image['Res'] = {
  //     code: 200,
  //     registry,
  //     namespace,
  //     name,
  //     reference,
  //     index: {},
  //     images: {},
  //     blobs: [],
  //     tags: [],
  //   };

  //   if (!reference.startsWith('sha256:')) {
  //     res.tags.push(reference);
  //   }

  //   const respond = (spec: Image['Req'], status: Image['Res']): Observable<ApiSchema<Image['Req'], Image['Res']>> => {
  //     this.log.debug(`Image Spec`, JSON.stringify(spec, null, 2));
  //     this.log.debug(`Image Status`, JSON.stringify(status, null, 2));
  //     return of({
  //       apiVersion: 'rowdy.run/v1alpha1',
  //       kind: 'Image',
  //       spec,
  //       status,
  //     });
  //   };

  //   const headers: Record<string, string | string[] | undefined> = {
  //     Accept: [
  //       'application/vnd.oci.image.index.v1+json',
  //       'application/vnd.docker.distribution.manifest.list.v2+json',
  //       'application/vnd.oci.image.manifest.v1+json',
  //       'application/vnd.docker.distribution.manifest.v2+json',
  //     ],
  //     Authorization: opts?.authorization,
  //   };

  //   return of(registryUrl(registry, namespace, name, reference, 'manifests'))
  //     .pipe(
  //       mergeMap((u) =>
  //         from(this.http.get<Image['External']['ImageIndex']>(u, { headers })).pipe(
  //           tap(() => this.log.debug(`Fetched index manifest from ${u}`)),
  //           map(({ data, headers, config }) => {
  //             if (data.schemaVersion !== 2) {
  //               res.index = data;
  //               throw new Error(`Unsupported schemaVersion on index: ${data.schemaVersion}`);
  //             }
  //             if (
  //               data.mediaType !== 'application/vnd.oci.image.index.v1+json' &&
  //               data.mediaType !== 'application/vnd.docker.distribution.manifest.list.v2+json'
  //             ) {
  //               res.index = data;
  //               throw new Error(`Unsupported mediaType on index: ${data.mediaType}`);
  //             }

  //             if (config.headers.Authorization) {
  //               opts = { ...opts, authorization: config.headers.Authorization as string };
  //             }

  //             res.reference = headers['docker-content-digest'] || reference;
  //             res.index = data;
  //             return (res.index.manifests || []).map((m) => ({
  //               platform: `${m.platform?.os}/${m.platform?.architecture}`,
  //               digest: m.digest!,
  //               url: registryUrl(registry, namespace, name, m.digest!, 'manifests'),
  //             }));
  //           }),
  //           mergeAll()
  //         )
  //       )
  //     )
  //     .pipe(
  //       mergeMap(({ platform, digest, url: u }) =>
  //         from(this.http.get<Image['External']['ImageManifest']>(u, { headers })).pipe(
  //           tap(() => this.log.debug(`Fetched ${platform} image manifest from ${u}`)),
  //           map(({ data }) => {
  //             if (data.schemaVersion !== 2) {
  //               res.images[digest] = data;
  //               throw new Error(`Unsupported schemaVersion on ${digest}: ${data.schemaVersion}`);
  //             }
  //             if (
  //               data.mediaType !== 'application/vnd.oci.image.manifest.v1+json' &&
  //               data.mediaType !== 'application/vnd.docker.distribution.manifest.v2+json'
  //             ) {
  //               res.images[digest] = data;
  //               throw new Error(`Unsupported mediaType on ${digest}: ${data.mediaType}`);
  //             }

  //             res.images[digest] = data;
  //             if (data.config && data.config.digest) {
  //               res.blobs.push({
  //                 ...data.config,
  //                 platform,
  //                 url: registryUrl(registry, namespace, name, data.config.digest, 'blobs'),
  //               });
  //             }
  //             res.blobs.push(
  //               ...(data.layers || [])
  //                 .filter((layer) => !!layer.digest)
  //                 .map((layer) => ({
  //                   ...layer,
  //                   platform,
  //                   url: registryUrl(registry, namespace, name, layer.digest!, 'blobs'),
  //                 }))
  //             );
  //           })
  //         )
  //       )
  //     )
  //     .pipe(toArray())
  //     .pipe(mergeMap(() => respond(req, res)))
  //     .pipe(
  //       catchError((err) => {
  //         this.log.warn(`Error fetching image ${req.image}: ${err.message}`);
  //         res.code = 206;
  //         res.reason = err.message;
  //         return respond(req, res);
  //       })
  //     );
  // }

  // putImage(req: Image['Req'], opts?: Image['Opts']['PUT']): Observable<ApiSchema<Image['Req'], Image['Res']>> {
  //   this.log.info(`Transferring image ${req.image}`, {
  //     concurrency: Upload.CONCURRENCY,
  //   });

  //   const toImage: Image['Res'] = {
  //     code: 206,
  //     registry: '',
  //     namespace: '',
  //     name: '',
  //     reference: '',
  //     index: {},
  //     images: {},
  //     blobs: [],
  //     tags: [],
  //   };

  //   return this.getImage(req, opts)
  //     .pipe(
  //       switchMap(({ status: fromImage }) =>
  //         this.api.Registry.getRegistry(opts).pipe(
  //           map(({ status }) => ({
  //             fromImage,
  //             toRegistry: status.registry,
  //             toNamespace: opts?.namepace || fromImage.namespace,
  //           }))
  //         )
  //       ),
  //       map(({ fromImage, toRegistry, toNamespace }) => {
  //         toImage.registry = toRegistry;
  //         toImage.namespace = toNamespace;
  //         toImage.name = fromImage.name;
  //         toImage.reference = fromImage.reference;
  //         return { fromImage };
  //       }),
  //       map(({ fromImage }) => {
  //         const blobs: Upload[] = [
  //           // First: Blobs
  //           ...fromImage.blobs.map((blob) => {
  //             const fromUrl = blob.url;
  //             const toUrl = fromUrl.replace(fromImage.registry, toImage.registry).replace(blob.digest!, `uploads/`);
  //             return new Upload(
  //               this.api,
  //               fromUrl,
  //               toUrl,
  //               {
  //                 digest: blob.digest!,
  //                 mediaType: blob.mediaType!,
  //                 size: blob.size!,
  //               },
  //               () => {
  //                 toImage.blobs.push({ ...blob, url: toUrl });
  //               }
  //             );
  //           }),
  //         ];

  //         const images = fromImage.tags
  //           .map((tag) => [
  //             ...Object.entries(fromImage.images).map(([digest, manifest]) => {
  //               const fromUrl = registryUrl(
  //                 fromImage.registry,
  //                 fromImage.namespace,
  //                 fromImage.name,
  //                 digest,
  //                 'manifests'
  //               );
  //               const toUrl = registryUrl(toImage.registry, toImage.namespace, toImage.name, tag, 'manifests');
  //               return new Upload(
  //                 this.api,
  //                 fromUrl,
  //                 toUrl,
  //                 {
  //                   digest,
  //                   mediaType: manifest.mediaType!,
  //                   size: manifest.size!,
  //                 },
  //                 () => {
  //                   toImage.images[digest] = manifest;
  //                 }
  //               );
  //             }),
  //           ])
  //           .flat();

  //         //TODO: index push still not happening
  //         //TODO: find out why errors aren't being reduced at the end
  //         const indexes = fromImage.tags.map(
  //           (tag) =>
  //             new Upload(
  //               this.api,
  //               registryUrl(fromImage.registry, fromImage.namespace, fromImage.name, fromImage.reference, 'manifests'),
  //               registryUrl(toImage.registry, toImage.namespace, toImage.name, tag, 'manifests'),
  //               {
  //                 digest: fromImage.reference,
  //                 mediaType: fromImage.index.mediaType!,
  //                 size: fromImage.index.size!,
  //               },
  //               () => {
  //                 toImage.index = fromImage.index;
  //               }
  //             )
  //         );

  //         this.log.info(`Prepared transfers for image ${req.image}`, {
  //           blobs: blobs.length,
  //           images: images.length,
  //           indexes: indexes.length,
  //         });

  //         const transfers: Transfers = { blobs, images, indexes };
  //         return transfers;
  //         // TODO: handle 404 if namespace doesn't exist
  //       })
  //     )
  //     .pipe(Upload.observeAll(this.log, 1000, Upload.CONCURRENCY, true)) // TODO: make verify optional
  //     .pipe(
  //       map((statuses) => {
  //         const response: ApiSchema<Image['Req'], Image['Res']> = {
  //           apiVersion: 'rowdy.run/v1alpha1',
  //           kind: 'Image',
  //           spec: req,
  //           status: {
  //             ...toImage,
  //             code: TransferStatus.code(statuses),
  //             reason: TransferStatus.reason(statuses),
  //           },
  //         };
  //         return response;
  //       }),
  //       tap((response) => {
  //         this.log.debug(`Image Spec`, JSON.stringify(response.spec));
  //         this.log.debug(`Image Status`, JSON.stringify(response.status));
  //         this.log.info(`Finished transferring image ${req.image} to ${response.status.registry}`, {
  //           status: response.status.code,
  //           reason: response.status.reason,
  //         });
  //       })
  //     );
  // }
}

// type Digest = string;
// type TransferRef = Omit<Required<Image['External']['Ref']>, 'annotations'>;
// type Transfers = { blobs: Upload[]; images: Upload[]; indexes: Upload[] };

// class Upload implements ILoggable {
//   private static _CONCURRENCY = {
//     MIN: 1,
//     MAX: 10,
//     CURRENT: 0,
//   };

//   static get CONCURRENCY(): number {
//     if (Upload._CONCURRENCY.CURRENT === 0) {
//       const cpus = os.cpus()?.length || Upload._CONCURRENCY.MIN;
//       // Use all of the possible CPUs, up to MAX
//       Upload._CONCURRENCY.CURRENT = Math.min(Math.max(Upload._CONCURRENCY.MIN, cpus), Upload._CONCURRENCY.MAX);
//     }
//     return Upload._CONCURRENCY.CURRENT;
//   }

//   private complete: boolean = false;
//   private bytes: { received: number; sent: number; total: number };

//   constructor(
//     public api: IApi,
//     public fromUrl: string,
//     public toUrl: string,
//     public ref: TransferRef,
//     public finalizer: () => void
//   ) {
//     this.bytes = { received: 0, sent: 0, total: ref.size || 0 };
//   }

//   static observeAll(
//     log: Logger,
//     interval: number,
//     concurrency: number,
//     verify?: boolean
//   ): OperatorFunction<Transfers, Record<Digest, TransferStatus>> {
//     const summary = (transfers: Transfers): string => {
//       const all = [...transfers.blobs, ...transfers.images, ...transfers.indexes];
//       const totalTransfers = all.length;
//       const completedTransfers = all.filter((t) => t.complete).length;

//       const totalBytes = all.reduce((acc, t) => acc + t.bytes.total, 0);
//       const completedBytes = all.reduce((acc, t) => acc + t.bytes.sent, 0);

//       const transferRatio = `${completedTransfers}/${totalTransfers}`;
//       const pct = totalBytes === 0 ? '100%' : `${((completedBytes / totalBytes) * 100).toFixed(0)}%`;
//       return `${transferRatio} transfers: ${pct} complete`;
//     };

//     return (source) =>
//       new Observable((subscriber) => {
//         let latest: Transfers | undefined = undefined;
//         const proc = setInterval(() => {
//           if (latest) log.info(`Transfer progess: ${summary(latest)}`);
//         }, interval);

//         const subscription = source
//           .pipe(
//             tap((transfers) => (latest = transfers)),
//             switchMap(({ blobs, images, indexes }) =>
//               concat(
//                 Upload.observe(blobs, concurrency, verify),
//                 Upload.observe(images, concurrency, verify),
//                 Upload.observe(indexes, concurrency, verify)
//               )
//             ),
//             reduce(
//               (acc, cur) => {
//                 cur.finalize();
//                 acc[cur.digest] = cur;
//                 return acc;
//               },
//               {} as Record<Digest, TransferStatus>
//             )
//           )
//           .subscribe(subscriber);

//         return () => {
//           if (latest) log.info(`Transfer complete: ${summary(latest)}`);
//           subscription.unsubscribe();
//           clearInterval(proc);
//         };
//       });
//   }

//   private static observe(transfers: Upload[], concurrency: number, verify?: boolean): Observable<TransferStatus> {
//     return from(transfers).pipe(mergeMap((transfer) => transfer.pipe(verify), concurrency));
//   }

//   get log(): Logger {
//     return this.api.log;
//   }

//   get http(): AxiosInstance {
//     return this.api.http;
//   }

//   get digest(): string {
//     return this.ref.digest;
//   }

//   get mediaType(): string {
//     return this.ref.mediaType;
//   }

//   repr(): string {
//     return `Transfer(from=${this.fromUrl}, to=${this.toUrl}, digest=${this.digest}, mediaType=${this.mediaType})`;
//   }
// }

// type Response<T> = { data: T | undefined; headers: HttpHeaders; status: number; method: string; url: string };

// class TransferStatus implements ILoggable {
//   private verified: boolean = false;
//   private _codes: number[] = [];
//   private _reasons: string[] = [];

//   static code(statuses: Record<Digest, TransferStatus>): number {
//     const failed = Object.values(statuses).find((s) => s.failed);
//     return failed ? 206 : 200;
//   }

//   static reason(statuses: Record<Digest, TransferStatus>): string | undefined {
//     const failures = Object.values(statuses).filter((s) => s.failed);
//     if (!failures.length) {
//       return undefined;
//     }
//     return failures
//       .map((s) => s._reasons)
//       .flat()
//       .join(', ');
//   }

//   constructor(private transfer: Upload) {}

//   get log(): Logger {
//     return this.transfer.api.log;
//   }

//   get http(): AxiosInstance {
//     return this.transfer.http;
//   }

//   get url(): string {
//     if (this.transfer.toUrl.endsWith('blobs/uploads/')) {
//       return this.transfer.toUrl.replace('blobs/uploads/', `blobs/${this.transfer.digest}`);
//     }
//     return this.transfer.toUrl;
//   }

//   get digest(): string {
//     return this.transfer.ref.digest;
//   }

//   get mediaType(): string {
//     return this.transfer.ref.mediaType;
//   }

//   get failed(): boolean {
//     return this._codes.some((c) => c >= 400);
//   }

//   intercept<T>(response: Promise<AxiosResponse<T>>): Observable<Response<T>> {
//     return defer(() => from(response)).pipe(
//       map((res) => {
//         this._codes.push(res.status);
//         this._reasons.push(this.reason(res));
//         return {
//           data: res.data,
//           headers: HttpHeaders.fromAxios(res.headers),
//           status: res.status,
//           method: res.config.method!,
//           url: res.config.url!,
//         };
//       }),
//       catchError((err) => {
//         this.log.warn(`Transfer error`, { error: err, transfer: this.transfer });
//         if (!isAxiosError(err)) {
//           return throwError(() => err);
//         }
//         this._codes.push(err.response?.status || 500);
//         this._reasons.push(this.reason(err.response!));
//         return of({
//           data: undefined,
//           headers: HttpHeaders.fromAxios(err.response?.headers || {}),
//           status: err.response?.status || 500,
//           method: err.config!.method!,
//           url: err.config!.url!,
//         });
//       })
//     );
//   }

//   withResponse<T>(response: Promise<AxiosResponse<T>>): Observable<this> {
//     return this.intercept(response).pipe(map(() => this));
//   }

//   verify(): Observable<this> {
//     if (this.verified) {
//       return of(this);
//     }

//     return defer(() => this.http.head(this.url)).pipe(
//       retry({
//         count: 3,
//         delay: (_, retryCount) => timer(Math.pow(2, retryCount) * 1000),
//         resetOnSuccess: true,
//       }),
//       map(() => {
//         this.log.debug(`Transfer verified`, { digest: this.digest, url: this.url });
//         this.verified = true;
//         return this;
//       }),
//       catchError((err) => {
//         if (!isAxiosError(err)) {
//           return throwError(() => err);
//         }

//         const reason = this.reason(err.response!);
//         this._codes.push(err.response?.status || 500);
//         this._reasons.push(reason);
//         this.log.warn(`Transfer verification failed`, { digest: this.digest, url: this.url, reason });

//         return of(this);
//       })
//     );
//   }

//   finalize(): void {
//     if (this.failed) {
//       return;
//     }
//     return this.transfer.finalizer();
//   }

//   private reason<T>(response: AxiosResponse<T>): string {
//     return `[${this.transfer.mediaType}] HTTP ${response.status}: ${response.config.method?.toUpperCase()} ${response.config.url}`;
//   }

//   repr(): string {
//     return `TransferStatus(digest=${this.digest}, mediaType=${this.mediaType}, url=${this.url}, verified=${this.verified})`;
//   }
// }

/*
TODO: Make logs match this
#34 [auth] scaffoldly/rowdy:pull,push token for ghcr.io
#34 DONE 0.0s
#33 exporting to image
#33 exporting manifest sha256:cf6ff12d727948dfd3a87fdd2fe148fff38ed6a76b26a0c4b43fc3208e10aec0 done
#33 exporting config sha256:44e47330ddb8b59c51c1440de7ab6ac4f9cd127da8f5074567104973043e10de done
#33 exporting attestation manifest sha256:de3f0ca9b8b8a197c715515493b8fa3adbddc78d42821bb9f9f73e8802535bbf done
#33 exporting manifest sha256:5d9251d573bdaa098fdaf7b5360198f89d725b5372a3bc6f311dac6811be8df8 done
#33 exporting config sha256:6390559d699de63fec1276846b9f0559da908a2d9da99b9ee364d06e190dfce4 done
#33 exporting attestation manifest sha256:e06eb88bceb1dbf9dd2202dce8d23a09a882253ddec86772eb9ca432fe425227 done
#33 exporting manifest list sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e done
#33 pushing layers
#33 pushing layers 2.9s done
#33 pushing manifest for ghcr.io/scaffoldly/rowdy:0.0.2-1-beta.20251028095209.ac8bae8@sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e
#33 pushing manifest for ghcr.io/scaffoldly/rowdy:0.0.2-1-beta.20251028095209.ac8bae8@sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e 2.4s done
#33 pushing layers 0.2s done
#33 pushing manifest for ghcr.io/scaffoldly/rowdy:beta@sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e
#33 pushing manifest for ghcr.io/scaffoldly/rowdy:beta@sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e 0.7s done
#33 pushing layers 0.3s done
#33 pushing manifest for ghcr.io/scaffoldly/rowdy:sha-ac8bae8@sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e
#33 pushing manifest for ghcr.io/scaffoldly/rowdy:sha-ac8bae8@sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e 0.5s done
*/
