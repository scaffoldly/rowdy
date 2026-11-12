import { AxiosAdapter, AxiosError, AxiosResponse, CanceledError, InternalAxiosRequestConfig } from 'axios';
import { Readable } from 'stream';
import axios from 'axios';
import { lastValueFrom, take } from 'rxjs';
import { HttpEvents, RETRY, RowdyHttp } from '../src/util/axios';
import { Rowdy } from '../src/api';
import { Logger } from '../src/log';
import { SandboxEnvironment } from '../src/sandbox/internal/environment';
import type { Event } from '../src/events';

// Both of rowdy's http instances, for a sandbox and for the CLI, retry as one from RowdyHttp does.
describe.each([
  ['RowdyHttp', () => RowdyHttp.from(axios.create())],
  ['a sandbox', () => new SandboxEnvironment(new Logger()).http],
  ['the CLI', () => new Rowdy(new Logger(), new AbortController().signal).http],
])("%s's http retries", (_name, made) => {
  const timing = { ...RETRY };
  beforeAll(() => Object.assign(RETRY, { minTimeout: 1, maxTimeout: 1 }));
  afterAll(() => Object.assign(RETRY, timing));

  type Answer = number | 'lost' | Error | { status: number; headers: Record<string, string> };

  // An instance whose requests are answered in turn by `answers`, the last one for every request after.
  const instance = (...answers: Answer[]) => {
    const seen: InternalAxiosRequestConfig[] = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push(config);
      const answer = answers[Math.min(seen.length - 1, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      if (answer === 'lost') throw new AxiosError('socket hang up', 'ECONNRESET', config);
      const { status, headers } = typeof answer === 'number' ? { status: answer, headers: {} } : answer;
      const response: AxiosResponse = { status, statusText: '', data: '', headers, config };
      if (status >= 400) throw new AxiosError('failed', 'ERR_BAD_RESPONSE', config, null, response);
      return response;
    };
    const http = made();
    http.defaults.adapter = adapter;
    return { http, seen };
  };

  it.each([429, 500, 502, 503, 504])('retries a %s', async (status) => {
    const { http, seen } = instance(status, 200);

    await expect(http.get('https://registry.example/v2/')).resolves.toMatchObject({ status: 200 });

    expect(seen).toHaveLength(2);
  });

  it('retries a connection lost before any response, as a 500', async () => {
    const { http, seen } = instance('lost', 200);

    await http.get('https://registry.example/v2/');

    expect(seen).toHaveLength(2);
  });

  it.each([400, 401, 403, 404])("doesn't retry a %s", async (status) => {
    const { http, seen } = instance(status);

    await expect(http.get('https://registry.example/v2/')).rejects.toMatchObject({ response: { status } });

    expect(seen).toHaveLength(1);
  });

  it('retries what a request asks it to, beyond its own', async () => {
    const { http, seen } = instance(404, 200);

    await http.get('https://mirror.example/v2/', { alsoRetry: [404] });

    expect(seen).toHaveLength(2);
  });

  it('gives up after its retries, with the last error', async () => {
    const { http, seen } = instance(503);

    await expect(http.get('https://registry.example/v2/')).rejects.toMatchObject({ response: { status: 503 } });

    expect(seen).toHaveLength(RETRY.retries + 1);
  });

  it('retries a body it can send again', async () => {
    const { http, seen } = instance(503, 201);

    await http.put('https://registry.example/v2/', Buffer.from('{}'));

    expect(seen).toHaveLength(2);
  });

  it("doesn't retry a stream body, spent by the attempt that failed", async () => {
    const { http, seen } = instance(503);

    await expect(http.put('https://registry.example/v2/', Readable.from(['x']))).rejects.toBeInstanceOf(AxiosError);

    expect(seen).toHaveLength(1);
  });

  it("doesn't retry once the host is out of outgoing requests", async () => {
    const { http, seen } = instance(new AxiosError('Too many subrequests.', 'ERR_NETWORK'));

    await expect(http.get('https://registry.example/v2/')).rejects.toThrow('Too many subrequests.');

    expect(seen).toHaveLength(1);
  });

  it("doesn't retry a request that was cancelled", async () => {
    const { http, seen } = instance(new CanceledError());

    await expect(http.get('https://registry.example/v2/')).rejects.toBeInstanceOf(CanceledError);

    expect(seen).toHaveLength(1);
  });

  it('stops waiting when its request is aborted', async () => {
    const { http, seen } = instance({ status: 429, headers: { 'retry-after': '3600' } }, 200);
    const controller = new AbortController();
    const started = Date.now();

    const got = http.get('https://mirror.gcr.io/v2/library/alpine/manifests/latest', { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    await expect(got).rejects.toBeInstanceOf(CanceledError);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen).toHaveLength(1);
  });

  it('lets a retried request be challenged for auth again', async () => {
    const { http, seen } = instance(503, 200);

    await http.get('https://registry.example/v2/', { _isRetry: true } as object);

    expect(seen[1]).toMatchObject({ _isRetry: false, attempt: 1 });
  });

  describe('rate limited', () => {
    const said = (http: RowdyHttp) => {
      const events: HttpEvents[] = [];
      http.events().subscribe((event) => events.push(event));
      return events;
    };

    it('waits as long as Retry-After says, rather than its own backoff', async () => {
      const { http, seen } = instance({ status: 429, headers: { 'retry-after': '1' } }, 200);
      const started = Date.now();

      await http.get('https://mirror.gcr.io/v2/library/alpine/manifests/latest');

      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
      expect(seen).toHaveLength(2);
    });

    it('says who limited what, and for how long', async () => {
      const { http } = instance({ status: 429, headers: { 'retry-after': '1' } }, 200);
      const events = said(http);

      await http.get('https://mirror.gcr.io/v2/library/alpine/blobs/sha256:abc');

      expect(events).toEqual([
        {
          type: 'rate-limited',
          summary: 'Rate limited by mirror.gcr.io pulling library/alpine, trying again in 1 second',
          wait: 1000,
          retryAfter: '1',
        },
      ]);
    });

    it('takes Retry-After as a date', async () => {
      const date = new Date(Date.now() + 1000).toUTCString();
      const { http } = instance({ status: 429, headers: { 'retry-after': date } }, 200);
      const events = said(http);

      await http.get('https://mirror.gcr.io/v2/acme/app/manifests/latest');

      expect(events).toEqual([
        {
          type: 'rate-limited',
          summary: expect.stringMatching(/^Rate limited by mirror.gcr.io pulling acme\/app, trying again in \d+ ms$/),
          wait: expect.any(Number),
          retryAfter: date,
        },
      ]);
    });

    it('says how long its own backoff is, without a Retry-After', async () => {
      const { http } = instance(429, 200);
      const events = said(http);

      await http.put('https://ecr.example/v2/acme/app/manifests/latest', Buffer.from('{}'));

      expect(events).toEqual([
        {
          type: 'rate-limited',
          summary: 'Rate limited by ecr.example pushing acme/app, trying again in 1 ms',
          wait: 1,
        },
      ]);
    });

    it("says nothing of a failure that isn't a rate limit", async () => {
      const { http } = instance(503, 200);
      const events = said(http);

      await http.get('https://mirror.gcr.io/v2/library/alpine/manifests/latest');

      expect(events).toEqual([]);
    });
  });
});

// Compiled, not called: a host tells an http event by its `source`, then its `type`.
const _wait = (event: Event): number | undefined =>
  event.source === 'http' && event.type === 'rate-limited' ? event.wait : undefined;

describe("a sandbox's events", () => {
  it('include what its http says', async () => {
    const environment = new SandboxEnvironment(new Logger());
    let calls = 0;
    // A 429 first, then the retry gets through.
    environment.http.defaults.adapter = async (config) => {
      const status = calls++ ? 200 : 429;
      const response: AxiosResponse = { status, statusText: '', data: '', headers: { 'retry-after': '0' }, config };
      if (status === 429) throw new AxiosError('failed', 'ERR_BAD_RESPONSE', config, null, response);
      return response;
    };
    const seen = lastValueFrom(environment.event$.pipe(take(1)));

    await environment.http.get('https://mirror.gcr.io/v2/library/alpine/manifests/latest');

    await expect(seen).resolves.toEqual({
      source: 'http',
      type: 'rate-limited',
      message: 'Rate limited by mirror.gcr.io pulling library/alpine, trying again in 0 ms',
      summary: 'Rate limited by mirror.gcr.io pulling library/alpine, trying again in 0 ms',
      wait: 0,
      retryAfter: '0',
    });
  });
});
