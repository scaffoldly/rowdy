import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  ListKeysCommand,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { lastValueFrom } from 'rxjs';
import { cdnStore, CloudFrontStore } from '../../src/cdn';

const ARN = 'arn:aws:cloudfront::442239336012:key-value-store/706d9bf2-5c29-4b7c-8900-89eb32d9723d';

type Sent = ListKeysCommand | DescribeKeyValueStoreCommand | UpdateKeysCommand;

// A store holding `items`, listed `pageSize` at a time; each update bumps the ETag.
const fakeStore = (items: Record<string, string>, pageSize = 100) => {
  const sent: Sent[] = [];
  let etag = 1;
  jest.spyOn(CloudFrontKeyValueStoreClient.prototype, 'send').mockImplementation((async (command: Sent) => {
    sent.push(command);
    if (command instanceof ListKeysCommand) {
      const start = Number(command.input.NextToken ?? 0);
      const keys = Object.keys(items);
      const next = start + pageSize;
      return {
        Items: keys.slice(start, next).map((Key) => ({ Key, Value: items[Key] })),
        NextToken: next < keys.length ? String(next) : undefined,
      };
    }
    if (command instanceof DescribeKeyValueStoreCommand) {
      return { ETag: `etag-${etag}` };
    }
    if (command.input.IfMatch !== `etag-${etag}`) {
      throw new Error(`stale ETag ${command.input.IfMatch}`);
    }
    command.input.Puts?.forEach(({ Key, Value }) => (items[Key!] = Value!));
    etag += 1;
    return { ETag: `etag-${etag}` };
  }) as never);
  return sent;
};

describe('cdn stores', () => {
  afterEach(() => jest.restoreAllMocks());

  it('recognizes a CloudFront KeyValueStore ARN', () => {
    expect(cdnStore(ARN)).toBeInstanceOf(CloudFrontStore);
    expect(cdnStore(ARN).name).toBe('cloudfront');
    expect(CloudFrontStore.from('arn:aws:cloudfront::442239336012:distribution/E123')).toBeUndefined();
    expect(() => cdnStore('app.workers.dev')).toThrow(/Invalid host target/);
  });

  it('puts only what changed and keeps keys it was not given', async () => {
    const items: Record<string, string> = { url: 'https://example.com/', SAME: 'v', CHANGED: 'old' };
    const sent = fakeStore(items);

    const written = await lastValueFrom(CloudFrontStore.from(ARN)!.write({ SAME: 'v', CHANGED: 'new', ADDED: 'a' }));

    expect(written).toEqual({ store: 'cloudfront', target: ARN, written: ['CHANGED', 'ADDED'], skipped: [] });
    expect(items).toEqual({ url: 'https://example.com/', SAME: 'v', CHANGED: 'new', ADDED: 'a' });
    expect(sent.filter((c) => c instanceof UpdateKeysCommand)).toHaveLength(1);
  });

  it('sends nothing but the listing when the store is up to date', async () => {
    const sent = fakeStore({ A: '1' });
    const written = await lastValueFrom(CloudFrontStore.from(ARN)!.write({ A: '1' }));
    expect(written.written).toEqual([]);
    expect(sent.every((c) => c instanceof ListKeysCommand)).toBe(true);
  });

  it('skips entries larger than the store allows', async () => {
    const items: Record<string, string> = {};
    fakeStore(items);
    const written = await lastValueFrom(
      CloudFrontStore.from(ARN)!.write({ BIG: 'x'.repeat(1025), FITS: 'x'.repeat(1024), ['K'.repeat(513)]: 'v' })
    );
    expect(written.written).toEqual(['FITS']);
    expect(written.skipped).toEqual(['BIG', 'K'.repeat(513)]);
    expect(Object.keys(items)).toEqual(['FITS']);
  });

  it('pages the listing and updates 50 keys at a time, each with the ETag before it', async () => {
    const items: Record<string, string> = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`OLD_${i}`, 'v']));
    const sent = fakeStore(items, 10);
    const environment = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`KEY_${i}`, `${i}`]));

    const written = await lastValueFrom(CloudFrontStore.from(ARN)!.write(environment));

    expect(written.written).toHaveLength(120);
    expect(sent.filter((c) => c instanceof ListKeysCommand)).toHaveLength(3);
    const updates = sent.filter((c): c is UpdateKeysCommand => c instanceof UpdateKeysCommand);
    expect(updates.map((c) => [c.input.IfMatch, c.input.Puts?.length])).toEqual([
      ['etag-1', 50],
      ['etag-2', 50],
      ['etag-3', 20],
    ]);
    expect(Object.keys(items)).toHaveLength(150);
  });
});
