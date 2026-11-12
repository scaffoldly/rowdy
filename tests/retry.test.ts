import { AxiosAdapter, AxiosError, AxiosResponse, CanceledError, InternalAxiosRequestConfig } from 'axios';
import { Readable } from 'stream';
import axios from 'axios';
import { RETRY, RowdyHttp } from '../src/util/axios';
import { Rowdy } from '../src/api';
import { Logger } from '../src/log';
import { SandboxEnvironment } from '../src/sandbox/internal/environment';

// Both of rowdy's http instances, for a sandbox and for the CLI, retry as one from RowdyHttp does.
describe.each([
  ['RowdyHttp', () => RowdyHttp.from(axios.create())],
  ['a sandbox', () => new SandboxEnvironment(new Logger()).http],
  ['the CLI', () => new Rowdy(new Logger(), new AbortController().signal).http],
])("%s's http retries", (_name, made) => {
  const timing = { ...RETRY };
  beforeAll(() => Object.assign(RETRY, { minTimeout: 1, maxTimeout: 1 }));
  afterAll(() => Object.assign(RETRY, timing));

  type Answer = number | 'lost' | Error;

  // An instance whose requests are answered in turn by `answers`, the last one for every request after.
  const instance = (...answers: Answer[]) => {
    const seen: InternalAxiosRequestConfig[] = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push(config);
      const answer = answers[Math.min(seen.length - 1, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      if (answer === 'lost') throw new AxiosError('socket hang up', 'ECONNRESET', config);
      const response: AxiosResponse = { status: answer, statusText: '', data: '', headers: {}, config };
      if (answer >= 400) throw new AxiosError('failed', 'ERR_BAD_RESPONSE', config, null, response);
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

  it('lets a retried request be challenged for auth again', async () => {
    const { http, seen } = instance(503, 200);

    await http.get('https://registry.example/v2/', { _isRetry: true } as object);

    expect(seen[1]).toMatchObject({ _isRetry: false, attempt: 1 });
  });
});
