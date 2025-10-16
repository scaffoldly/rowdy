import {
  catchError,
  combineLatest,
  concatMap,
  from,
  map,
  mergeAll,
  mergeMap,
  NEVER,
  Observable,
  of,
  switchMap,
  tap,
  throwError,
  toArray,
} from 'rxjs';
import { AxiosInstance } from 'axios';
import { ApiSchema, Image } from './types';
import { Readable } from 'stream';
import { Api } from '.';
import { Logger } from '../log';

export class ImageApi {
  constructor(private api: Api) {}

  get http(): AxiosInstance {
    return this.api.http;
  }

  get log(): Logger {
    return this.api.log;
  }

  putImage(req: Image['Req'], opts?: Image['Opts']['PUT']): Observable<ApiSchema<Image['Req'], Image['Res']>> {
    const CONCURRENCY = 5;
    this.log.info(`Transferring image ${req.image} (concurrency: ${CONCURRENCY})`);

    const res: Image['Res'] = {
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

    combineLatest([this.getImage(req, opts), this.api.Registry.getRegistry(opts || {})])
      .pipe(
        switchMap(([{ status: fromImage }, { status: registry }]) =>
          this.getImage(
            {
              image:
                (req.image = `${registry.registry}/${fromImage.namespace}/${fromImage.name}:${fromImage.reference}`),
            },
            opts
          ).pipe(
            tap(({ status }) => {
              this.log.info(`Transferring ${fromImage.images.length} images to ${registry.registry}`);
              // Set details from the target image
              res.registry = status.registry;
              res.namespace = status.namespace;
              res.name = status.name;
              // Copy over details from the source image
              res.reference = fromImage.reference;
              res.index = fromImage.index;
              res.images = fromImage.images;
              res.tags = fromImage.tags;
            }),
            map(({ status: toImage }) => ({ fromImage, toImage })),
            mergeMap(
              ({ fromImage, toImage }) =>
                from(fromImage.blobs).pipe(
                  map((blob) => {
                    const toUrl = `${blob.url.replace(fromImage.registry, toImage.registry).replace(blob.digest!, 'uploads/')}?digest=${blob.digest}`;
                    return { blob, toUrl };
                  })
                ),
              CONCURRENCY
            ),
            concatMap(({ blob, toUrl }) => {
              this.log.debug(`Transferring ${blob.digest} to ${registry.registry}`);
              return from(
                this.http.get<Readable>(blob.url, {
                  responseType: 'stream',
                  headers: { 'Content-Type': blob.mediaType! },
                  onDownloadProgress: (e) => this.log.debug(`Downloading ${blob.digest}: ${e.loaded} bytes`),
                })
              ).pipe(
                switchMap(({ data }) =>
                  from(
                    this.http.post(toUrl, data, {
                      maxBodyLength: Infinity,
                      headers: { 'Content-Type': blob.mediaType! },
                      onUploadProgress: (e) => this.log.debug(`Uploading ${blob.digest}: ${e.loaded} bytes`),
                    })
                  )
                ),
                tap(() => {
                  this.log.debug(`Transferred ${blob.digest} to ${registry.registry}`);
                  res.blobs.push({ ...blob, url: toUrl });
                })
              );
            })
          )
        )
      )
      .pipe(toArray())
      .pipe(
        switchMap((uploads) => {
          this.log.debug(`Transferred ${uploads.length} blobs`);
          const manifests = [
            // Image manifests
            ...Object.entries(res.images).map(([digest, manifest]) => ({
              url: `${res.registry}/${res.namespace}/${res.name}/manifests/${digest}`,
              manifest,
              mediaType: manifest.mediaType,
            })),
            // Index manifest
            {
              url: `${res.registry}/${res.namespace}/${res.name}/manifests/${res.reference}`,
              manifest: res.index,
              mediaType: res.index.mediaType,
            },
            // Tags
            ...res.tags.map((tag) => ({
              url: `${res.registry}/${res.namespace}/${res.name}/manifests/${tag}`,
              manifest: res.index,
              mediaType: res.index.mediaType,
            })),
          ];
          this.log.debug(`Pushing ${manifests.length} manifests`);
          return from(manifests).pipe(
            concatMap(({ url, manifest }) =>
              from(this.http.put(url, manifest, { headers: { 'Content-Type': manifest.mediaType! } })).pipe(
                tap(() => this.log.debug(`Pushed ${manifest.mediaType} manifest to ${url}`))
              )
            )
          );
        })
      )
      .pipe(
        toArray(),
        map((manifests) => {
          this.log.info(`Transferred ${res.blobs.length} blobs and pushed ${manifests.length} manifests`);
          res.code = 200;
          return respond(req, res);
        }),
        catchError((err) => {
          this.log.warn(`Error transferring image ${req.image}: ${err.message}`);
          res.code = 206;
          res.reason = err.message;
          return respond(req, res);
        })
      );

    return NEVER;
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
