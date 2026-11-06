import {
  BucketLocationConstraint,
  CreateBucketCommand,
  GetBucketTaggingCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  S3Client,
  Tag,
} from '@aws-sdk/client-s3';
import { MetadataBearer } from '@smithy/types';
import { randomBytes } from 'crypto';
import {
  catchError,
  concatMap,
  defaultIfEmpty,
  defer,
  EMPTY,
  filter,
  from,
  map,
  Observable,
  of,
  switchMap,
  take,
  tap,
} from 'rxjs';
import { Logger } from '../log';

type S3Error = { name?: string };

const isLocationConstraint = (region: string): region is BucketLocationConstraint =>
  Object.values<string>(BucketLocationConstraint).includes(region);

const createBucket = (s3: S3Client, log: Logger, Bucket: string, Tags?: Tag[]): Observable<MetadataBearer> =>
  from(s3.config.region()).pipe(
    switchMap((region) => {
      log.info('Bucket Creating', { bucket: Bucket, region });
      const location = region !== 'us-east-1' && isLocationConstraint(region) ? { LocationConstraint: region } : {};
      const configuration = { ...location, ...(Tags ? { Tags } : {}) };
      return s3.send(
        new CreateBucketCommand({
          Bucket,
          ...(Object.keys(configuration).length ? { CreateBucketConfiguration: configuration } : {}),
        })
      );
    }),
    catchError((created: unknown) => {
      if ((created as S3Error)?.name === 'BucketAlreadyOwnedByYou') return of({ $metadata: {} });
      throw created;
    })
  );

// DEVNOTE: Created when missing, never deleted or reconfigured: S3's defaults (Block Public
// Access, SSE-S3, bucket-owner-enforced ownership) apply.
export const ensureBucket = (s3: S3Client, log: Logger, Bucket: string): Observable<MetadataBearer> =>
  defer(() => s3.send(new HeadBucketCommand({ Bucket }))).pipe(
    tap(() => log.debug('Bucket Exists', { bucket: Bucket })),
    catchError((error: unknown) => {
      if ((error as S3Error)?.name !== 'NotFound') {
        throw error;
      }
      return createBucket(s3, log, Bucket);
    })
  );

/**
 * This region's bucket named `{prefix}…` and tagged `owner`, the first by name if there are several, so that first
 * runs at once converge. Without one, creates `{prefix}{random}`, as Terraform's `bucket_prefix` does.
 */
export const ownedBucket = (s3: S3Client, log: Logger, Prefix: string, owner: Tag): Observable<string> =>
  defer(() => s3.config.region()).pipe(
    switchMap((BucketRegion) => s3.send(new ListBucketsCommand({ Prefix, BucketRegion }))),
    switchMap(({ Buckets = [] }) => from(Buckets.flatMap(({ Name }) => Name ?? []).sort())),
    concatMap((Bucket) =>
      from(s3.send(new GetBucketTaggingCommand({ Bucket }))).pipe(
        catchError((error: unknown) => {
          if (['NoSuchTagSet', 'NoSuchBucket'].includes(`${(error as S3Error)?.name}`)) return EMPTY;
          throw error;
        }),
        filter(({ TagSet = [] }) => TagSet.some(({ Key, Value }) => Key === owner.Key && Value === owner.Value)),
        map(() => Bucket)
      )
    ),
    take(1),
    defaultIfEmpty(undefined),
    switchMap((Bucket) => {
      if (Bucket) return of(Bucket);
      const created = `${Prefix}${randomBytes(8).toString('hex')}`;
      return createBucket(s3, log, created, [owner]).pipe(map(() => created));
    })
  );
