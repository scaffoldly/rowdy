import '@aws-sdk/signature-v4a';
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  ListKeysCommand,
  PutKeyRequestListItem,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { Logger } from '@smithy/types';
import {
  bufferCount,
  defer,
  EMPTY,
  expand,
  from,
  last,
  map,
  mergeMap,
  mergeScan,
  Observable,
  of,
  reduce,
  switchMap,
} from 'rxjs';
import { log as root } from '../../log';
import { CdnStore, Written } from '../store';

const log = root.child('cdn');

// CloudFront KeyValueStore quotas.
const MAX_KEY_BYTES = 512;
const MAX_VALUE_BYTES = 1024;
const MAX_KEYS_PER_UPDATE = 50;

/** A CloudFront KeyValueStore, named by its ARN, which CloudFront Functions read with `cf.kvs()`. */
export class CloudFrontStore extends CdnStore {
  private static readonly ARN = /^arn:aws[a-z-]*:cloudfront::\d{12}:key-value-store\/[A-Za-z0-9-]+$/;

  /** The store a `spec.hosts` value names; undefined when it is not a KeyValueStore ARN. */
  static from(target: string): CloudFrontStore | undefined {
    return CloudFrontStore.ARN.test(target) ? new CloudFrontStore(target) : undefined;
  }

  get name(): string {
    return 'cloudfront';
  }

  write(values: Record<string, string>, logger?: Logger): Observable<Written> {
    const KvsARN = this.target;
    const client = new CloudFrontKeyValueStoreClient({ logger });
    const fits = ([key, value]: [string, string]): boolean =>
      Buffer.byteLength(key) <= MAX_KEY_BYTES && Buffer.byteLength(value) <= MAX_VALUE_BYTES;
    const entries = Object.entries(values);
    const skipped = entries.filter((entry) => !fits(entry)).map(([key]) => key);

    return defer(() => client.send(new ListKeysCommand({ KvsARN }))).pipe(
      expand((page) =>
        page.NextToken ? client.send(new ListKeysCommand({ KvsARN, NextToken: page.NextToken })) : EMPTY
      ),
      mergeMap((page) => page.Items ?? []),
      reduce(
        (existing, { Key, Value }) => (Key ? existing.set(Key, Value) : existing),
        new Map<string, string | undefined>()
      ),
      map((existing) => entries.filter((entry) => fits(entry) && existing.get(entry[0]) !== entry[1])),
      switchMap((changed) => {
        const Puts = changed.map(([Key, Value]): PutKeyRequestListItem => ({ Key, Value }));
        const result: Written = { store: this.name, target: KvsARN, written: changed.map(([key]) => key), skipped };
        if (!Puts.length) {
          log.debug('Store Unchanged', { store: this.name, target: KvsARN, skipped });
          return of(result);
        }
        // Each update takes the ETag the one before it returned.
        return defer(() => client.send(new DescribeKeyValueStoreCommand({ KvsARN }))).pipe(
          switchMap(({ ETag }) =>
            from(Puts).pipe(
              bufferCount(MAX_KEYS_PER_UPDATE),
              mergeScan(
                (IfMatch, batch) =>
                  from(client.send(new UpdateKeysCommand({ KvsARN, IfMatch, Puts: batch }))).pipe(
                    map(({ ETag: next }) => next)
                  ),
                ETag,
                1
              ),
              last(),
              map(() => result)
            )
          )
        );
      })
    );
  }
}
