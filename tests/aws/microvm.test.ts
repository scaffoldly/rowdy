import { createServer } from 'http';
import { AddressInfo } from 'net';
import { mergeMap, Observable, Subscription } from 'rxjs';
import { Environment, Logger } from '../../src';
import { HOOKS_PORT, MicrovmPipeline, MicrovmRequest } from '../../src/aws/microvm';
import { Pipeline, Result } from '../../src/pipeline';

describe('aws microvm pipeline', () => {
  const HOOKS = '/aws/lambda-microvms/runtime/v1';
  const ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:acme';
  const environment = new Environment(new Logger(), {});

  let subscription: Subscription | undefined;

  afterEach(() => {
    subscription?.unsubscribe();
    subscription = undefined;
    delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN;
  });

  const freePort = (): Promise<number> =>
    new Promise((resolve) => {
      const probe = createServer().listen(0, () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });

  // What Environment.poll does with a pipeline's requests.
  const answered = (pipeline: MicrovmPipeline): Observable<Result<Pipeline>> =>
    pipeline.into().pipe(
      mergeMap((request) => request.into()),
      mergeMap((proxy) => proxy.into()),
      mergeMap((response) => response.into())
    );

  const serve = async (results: Result<Pipeline>[] = []): Promise<string> => {
    const port = await freePort();
    process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = ARN;
    subscription = answered(new MicrovmPipeline(environment, port)).subscribe((result) => results.push(result));
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fetch(url).catch(() => undefined)) return url;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('hooks never listened');
  };

  it.each(['ready', 'validate', 'run'])('answers the %s hook', async (hook) => {
    const url = await serve();

    const response = await fetch(`${url}${HOOKS}/${hook}`, {
      method: 'POST',
      body: JSON.stringify({ microvmId: 'mvm-1', runHookPayload: 'payload' }),
    });

    expect(response.status).toBe(200);
  });

  it('reports a hook as a result', async () => {
    const results: Result<Pipeline>[] = [];
    const url = await serve(results);
    results.length = 0;

    await fetch(`${url}${HOOKS}/ready`, { method: 'POST' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ success: true, status: 200 });
  });

  it('names the hook, and never the payload, in its logs', async () => {
    const requests: MicrovmRequest[] = [];
    const port = await freePort();
    process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = ARN;
    subscription = new MicrovmPipeline(environment, port).into().subscribe((request) => {
      requests.push(request as MicrovmRequest);
      (request as MicrovmRequest).res.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await fetch(`http://127.0.0.1:${port}${HOOKS}/run`, { method: 'POST', body: 'secret' });

    expect(requests[0]?.brief()).toEqual({ hook: 'run' });
    expect(requests[0]?.repr()).toBe('MicrovmRequest(hook=run)');
  });

  it('listens on the first ephemeral port by default', () => {
    expect(HOOKS_PORT).toBe(32768);
  });

  it.each([`${HOOKS}/suspend`, `${HOOKS}/terminate`, '/ready', '/'])('refuses %s', async (path) => {
    const url = await serve();

    const response = await fetch(`${url}${path}`, { method: 'POST' });

    expect(response.status).toBe(404);
  });

  it('stops listening when unsubscribed', async () => {
    const url = await serve();

    subscription?.unsubscribe();

    await expect(fetch(`${url}${HOOKS}/ready`, { method: 'POST' })).rejects.toThrow();
  });

  it('fails when the port is taken', async () => {
    const taken = createServer().listen(0);
    await new Promise((resolve) => taken.once('listening', resolve));
    process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = ARN;
    const { port } = taken.address() as AddressInfo;

    const error = new Promise((resolve) => {
      subscription = new MicrovmPipeline(environment, port).into().subscribe({ error: resolve });
    });

    await expect(error).resolves.toMatchObject({ code: 'EADDRINUSE' });
    taken.close();
  });

  it('stays out of the way outside a microVM', () => {
    const next = jest.fn();
    const listen = jest.spyOn(require('http').Server.prototype, 'listen');

    subscription = new MicrovmPipeline(environment).into().subscribe(next);

    expect(listen).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    listen.mockRestore();
  });

  it('runs alongside the other pipelines', () => {
    expect(environment['_pipelines'].some((p) => p instanceof MicrovmPipeline)).toBe(true);
  });
});
