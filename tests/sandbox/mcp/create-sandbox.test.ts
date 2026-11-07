import type { ServerContext } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Subject } from 'rxjs';
import type { Event } from '../../../src/events';
import type { Sandbox, SandboxFactory, SandboxOptions, SandboxToolsOptions } from '../../../src/sandbox';
import { PROGRESS, createSandbox } from '../../../src/sandbox/mcp/create-sandbox';

const sandboxId = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox-bcdf245678';

const setup = (
  options: SandboxToolsOptions = {},
  create: (event$: Subject<Event>) => Promise<Sandbox> = async () => ({ sandboxId }) as Sandbox
) => {
  const event$ = new Subject<Event>();
  const spy = jest.fn((() =>
    Object.assign(create(event$), { events: () => event$ })) as unknown as SandboxFactory['create']);
  const notify = jest.fn(async (_notification: { params: { message: string; progress: number } }) => {});
  const tool = createSandbox({ create: spy }, options);
  const run = (input: Record<string, unknown> = {}, _meta?: { progressToken: string }) =>
    tool.run(tool.inputSchema.parse(input), { mcpReq: { _meta, notify } } as unknown as ServerContext);
  const passed = (): SandboxOptions => spy.mock.calls[0]?.[0] as SandboxOptions;
  return { tool, run, passed, notify, spy };
};

describe('create_sandbox', () => {
  it('takes what a model may choose, and nothing of the host', () => {
    const { tool } = setup();

    expect(Object.keys(tool.inputSchema.shape).sort()).toEqual([
      'env',
      'image',
      'memory',
      'name',
      'runtime',
      'timeout',
    ]);
  });

  it('answers with the sandboxId as text and as structured content', async () => {
    const { run } = setup();

    expect(await run()).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ sandbox_id: sandboxId }) }],
      structuredContent: { sandbox_id: sandboxId },
    });
  });

  it('passes its input on', async () => {
    const { run, passed } = setup();

    await run({ runtime: 'aws.microvm', image: 'node:24', timeout: 60000, memory: 1024, env: { CI: 'true' } });

    expect(passed()).toMatchObject({
      runtime: 'aws.microvm',
      image: 'node:24',
      timeout: 60000,
      memory: 1024,
      env: { CI: 'true' },
    });
  });

  it('passes the host logLevel and signal on', async () => {
    const { signal } = new AbortController();
    const { run, passed } = setup({ logLevel: 'error', signal });

    await run();

    expect(passed()).toMatchObject({ logLevel: 'error', signal });
  });

  it('leaves unset options for the SDK to default', async () => {
    const { run, passed } = setup();

    await run();

    expect(passed()).toMatchObject({ runtime: undefined, timeout: undefined, memory: undefined, name: undefined });
  });

  it('rejects when the SDK rejects', async () => {
    const { run } = setup({}, async () => {
      throw new RangeError('memory must be whole MB from 128 to 10240, got 1');
    });

    await expect(run({ memory: 1 })).rejects.toThrow(RangeError);
  });

  describe('name', () => {
    it("uses the model's name alone without a host name", async () => {
      const { run, passed } = setup();

      await run({ name: 'builds' });

      expect(passed().name).toBe('builds');
    });

    it("puts the host's name first", async () => {
      const { run, passed } = setup({ name: 'tenant' });

      await run({ name: 'builds' });

      expect(passed().name).toBe('tenant-builds');
    });

    it("uses the host's name alone without a model's name", async () => {
      const { run, passed } = setup({ name: 'tenant' });

      await run();

      expect(passed().name).toBe('tenant');
    });
  });

  describe('limits', () => {
    it('refuses memory above the cap', async () => {
      const { run, spy } = setup({ limits: { memory: 1024 } });

      await expect(run({ memory: 2048 })).rejects.toThrow('memory must be at most 1024 MB, got 2048');
      expect(spy).not.toHaveBeenCalled();
    });

    it('refuses a timeout above the cap', async () => {
      const { run, spy } = setup({ limits: { timeout: 60000 } });

      await expect(run({ timeout: 120000 })).rejects.toThrow('timeout must be at most 60000 ms, got 120000');
      expect(spy).not.toHaveBeenCalled();
    });

    it('refuses a runtime that is not allowed', async () => {
      const { run, spy } = setup({ limits: { runtimes: ['aws.microvm'] } });

      await expect(run({ runtime: 'aws.lambda' })).rejects.toThrow(
        'runtime must be one of aws.microvm, got aws.lambda'
      );
      expect(spy).not.toHaveBeenCalled();
    });

    it('allows values at the cap', async () => {
      const { run, passed } = setup({ limits: { memory: 1024, timeout: 60000 } });

      await run({ memory: 1024, timeout: 60000 });

      expect(passed()).toMatchObject({ memory: 1024, timeout: 60000 });
    });

    it('holds an omitted value to a cap below its default', async () => {
      const { run, passed } = setup({ limits: { memory: 256, timeout: 60000 } });

      await run();

      expect(passed()).toMatchObject({ memory: 256, timeout: 60000 });
    });

    it('keeps the default of an omitted value under a higher cap', async () => {
      const { run, passed } = setup({ limits: { memory: 8192, timeout: 3600000 } });

      await run();

      expect(passed()).toMatchObject({ memory: 512, timeout: 900000 });
    });

    it('defaults to the first allowed runtime', async () => {
      const { run, passed } = setup({ limits: { runtimes: ['aws.microvm', 'aws.lambda'] } });

      await run();

      expect(passed().runtime).toBe('aws.microvm');
    });
  });

  describe('progress', () => {
    const { delay } = PROGRESS;

    beforeEach(() => {
      PROGRESS.delay = 1;
    });

    afterEach(() => {
      PROGRESS.delay = delay;
    });

    const slow = async (): Promise<Sandbox> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { sandboxId } as Sandbox;
    };

    it('notifies a client that asked, while it builds', async () => {
      let built: (sandbox: Sandbox) => void = () => {};
      const { run, notify } = setup({}, () => new Promise((resolve) => (built = resolve)));
      notify.mockImplementation(async () => built({ sandboxId } as Sandbox));

      await run({}, { progressToken: 'token' });

      expect(notify).toHaveBeenCalled();
      expect(notify.mock.calls[0]).toEqual([
        {
          method: 'notifications/progress',
          params: { progressToken: 'token', progress: 1, message: 'Creating the sandbox' },
        },
      ]);
    });

    const step: Event = {
      source: 'cdk',
      message: 'CreateRole: creating',
      type: 'create',
      lifecycle: 'creating',
      client: 'IAMClient',
      action: 'CreateRole',
    };

    const stepping = async (event$: Subject<Event>): Promise<Sandbox> => {
      await Promise.resolve();
      event$.next({ ...step, type: 'read', lifecycle: 'reading', message: 'GetRole: reading' });
      event$.next(step);
      event$.next({ ...step, lifecycle: 'failed', message: 'CreateFunction: failed' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { sandboxId } as Sandbox;
    };

    it('reports every step', async () => {
      PROGRESS.delay = 60000;
      const { run, notify } = setup({}, stepping);

      await run({}, { progressToken: 'token' });

      expect(notify.mock.calls.map(([{ params }]) => params.message)).toEqual([
        'GetRole: reading',
        'CreateRole: creating',
        'CreateFunction: failed',
      ]);
    });

    it('reports a transfer', async () => {
      PROGRESS.delay = 60000;
      const { run, notify } = setup({}, async (event$) => {
        await Promise.resolve();
        event$.next({
          source: 'transfer',
          message: 'Copying the image: 40%',
          lifecycle: 'copying',
          summary: '40%',
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { sandboxId } as Sandbox;
      });

      await run({}, { progressToken: 'token' });

      expect(notify.mock.calls.map(([{ params }]) => params.message)).toEqual(['Copying the image: 40%']);
    });

    it('only ever counts up, across steps and the steady notification', async () => {
      const { run, notify } = setup({}, stepping);

      await run({}, { progressToken: 'token' });

      const progress = notify.mock.calls.map(([{ params }]) => params.progress);
      expect(progress).toEqual(progress.map((_, index) => index + 1));
    });

    it('stops when the build is done', async () => {
      const { run, notify } = setup({}, slow);

      await run({}, { progressToken: 'token' });
      const { length } = notify.mock.calls;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(notify.mock.calls.length).toBe(length);
    });

    it('stays quiet for a client that did not ask', async () => {
      const { run, notify } = setup({}, slow);

      await run();

      expect(notify).not.toHaveBeenCalled();
    });

    it('still answers when a notification fails', async () => {
      const { run, notify } = setup({}, slow);
      notify.mockRejectedValue(new Error('closed'));

      expect(await run({}, { progressToken: 'token' })).toMatchObject({ structuredContent: { sandbox_id: sandboxId } });
    });
  });
});
