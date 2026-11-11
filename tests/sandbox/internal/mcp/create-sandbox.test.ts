import type { ServerContext } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Subject } from 'rxjs';
import type { Event } from '../../../../src/events';
import type { Sandbox, SandboxFactory, SandboxOptions } from '../../../../src/sandbox';
import { PROGRESS, createSandbox } from '../../../../src/sandbox/internal/mcp/create-sandbox';

const sandboxId = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox-bcdf245678';

const setup = (
  create: (event$: Subject<Event>) => Promise<Sandbox> = async () =>
    ({ sandboxId, status: async () => ({ state: 'ready' }) }) as unknown as Sandbox
) => {
  const event$ = new Subject<Event>();
  const spy = jest.fn((() =>
    Object.assign(create(event$), { events: () => event$ })) as unknown as SandboxFactory['create']);
  const notify = jest.fn(async (_notification: { params: { message: string; progress: number } }) => {});
  const tool = createSandbox;
  const sandboxes = { create: spy } as unknown as SandboxFactory;
  const run = (input: Record<string, unknown> = {}, _meta?: { progressToken: string }) =>
    tool.run(sandboxes, tool.inputSchema.parse(input), { mcpReq: { _meta, notify } } as unknown as ServerContext);
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
      content: [{ type: 'text', text: JSON.stringify({ sandbox_id: sandboxId, state: 'ready' }) }],
      structuredContent: { sandbox_id: sandboxId, state: 'ready' },
    });
  });

  it("answers while it builds, and says what to do until it's ready", async () => {
    const { run, passed } = setup(async () => ({ sandboxId, status: async () => ({ state: 'building' }) }) as never);

    const { structuredContent, content } = await run();

    expect(passed()).toMatchObject({ wait: false });
    expect(structuredContent).toEqual({ sandbox_id: sandboxId, state: 'building' });
    expect(content[1]).toEqual({ type: 'text', text: expect.stringContaining('call get_sandbox') });
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

  it('passes on only what the model gave', async () => {
    const { run, passed } = setup();

    await run();

    expect(passed()).toEqual({ wait: false });
  });

  it('rejects when the SDK rejects', async () => {
    const { run } = setup(async () => {
      throw new RangeError('memory must be whole MB from 128 to 10240, got 1');
    });

    await expect(run({ memory: 1 })).rejects.toThrow('memory must be whole MB from 128 to 10240, got 1');
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
      return { sandboxId, status: async () => ({ state: 'ready' }) } as unknown as Sandbox;
    };

    it('notifies a client that asked, while it builds', async () => {
      let built: (sandbox: Sandbox) => void = () => {};
      const { run, notify } = setup(() => new Promise((resolve) => (built = resolve)));
      notify.mockImplementation(async () =>
        built({ sandboxId, status: async () => ({ state: 'ready' }) } as unknown as Sandbox)
      );

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
      return { sandboxId, status: async () => ({ state: 'ready' }) } as unknown as Sandbox;
    };

    it('notifies at once, before anything slow', async () => {
      PROGRESS.delay = 60000;
      const { run, notify } = setup(slow);

      await run({}, { progressToken: 'token' });

      expect(notify.mock.calls.map(([{ params }]) => params.message)).toEqual(['Creating the sandbox']);
    });

    it('reports every step', async () => {
      PROGRESS.delay = 60000;
      const { run, notify } = setup(stepping);

      await run({}, { progressToken: 'token' });

      expect(notify.mock.calls.map(([{ params }]) => params.message)).toEqual([
        'Creating the sandbox',
        'GetRole: reading',
        'CreateRole: creating',
        'CreateFunction: failed',
      ]);
    });

    it('reports a transfer', async () => {
      PROGRESS.delay = 60000;
      const { run, notify } = setup(async (event$) => {
        await Promise.resolve();
        event$.next({
          source: 'transfer',
          message: 'Copying the image: 40%',
          lifecycle: 'copying',
          summary: '40%',
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { sandboxId, status: async () => ({ state: 'ready' }) } as unknown as Sandbox;
      });

      await run({}, { progressToken: 'token' });

      expect(notify.mock.calls.map(([{ params }]) => params.message)).toEqual([
        'Creating the sandbox',
        'Copying the image: 40%',
      ]);
    });

    it('only ever counts up, across steps and the steady notification', async () => {
      const { run, notify } = setup(stepping);

      await run({}, { progressToken: 'token' });

      const progress = notify.mock.calls.map(([{ params }]) => params.progress);
      expect(progress).toEqual(progress.map((_, index) => index + 1));
    });

    it('stops when the build is done', async () => {
      const { run, notify } = setup(slow);

      await run({}, { progressToken: 'token' });
      const { length } = notify.mock.calls;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(notify.mock.calls.length).toBe(length);
    });

    it('stays quiet for a client that did not ask', async () => {
      const { run, notify } = setup(slow);

      await run();

      expect(notify).not.toHaveBeenCalled();
    });

    it('still answers when a notification fails', async () => {
      const { run, notify } = setup(slow);
      notify.mockRejectedValue(new Error('closed'));

      expect(await run({}, { progressToken: 'token' })).toMatchObject({ structuredContent: { sandbox_id: sandboxId } });
    });
  });
});
