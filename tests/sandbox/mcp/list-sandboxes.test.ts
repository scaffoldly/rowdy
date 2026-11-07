import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { SandboxFactory, SandboxSummary, SandboxToolsOptions } from '../../../src/sandbox';
import { listSandboxes } from '../../../src/sandbox/mcp/list-sandboxes';

const STARTED = new Date('2026-11-07T21:00:00.000Z');
const found: SandboxSummary[] = [
  {
    sandboxId: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:tenant-a-bcdf2',
    name: 'tenant-a-bcdf2',
    runtime: 'aws.microvm',
    running: true,
    startedAt: STARTED,
    stopsAt: new Date(STARTED.getTime() + 900_000),
  },
  {
    sandboxId: 'arn:aws:lambda:us-east-1:123456789012:function:tenant-b-ghjk4',
    name: 'tenant-b-ghjk4',
    runtime: 'aws.lambda',
  },
];

const setup = (options: SandboxToolsOptions = {}) => {
  const list = jest.fn(async (_options: unknown) => found);
  const tool = listSandboxes({ list: list as unknown as SandboxFactory['list'] }, options);
  const run = (input: Record<string, unknown> = {}) => tool.run(tool.inputSchema.parse(input), {} as ServerContext);
  return { tool, run, list };
};

describe('list_sandboxes', () => {
  it('answers with each sandbox, and when a running one stops', async () => {
    const { run } = setup();

    expect((await run()).structuredContent).toEqual({
      sandboxes: [
        {
          sandbox_id: found[0]!.sandboxId,
          name: 'tenant-a-bcdf2',
          runtime: 'aws.microvm',
          running: true,
          started_at: '2026-11-07T21:00:00.000Z',
          stops_at: '2026-11-07T21:15:00.000Z',
        },
        { sandbox_id: found[1]!.sandboxId, name: 'tenant-b-ghjk4', runtime: 'aws.lambda' },
      ],
    });
  });

  it('lists only its scope, on the runtime asked for, with the host signal', async () => {
    const { signal } = new AbortController();
    const { run, list } = setup({ name: 'tenant', signal });

    await run({ runtime: 'aws.microvm' });

    expect(list).toHaveBeenCalledWith({ runtime: 'aws.microvm', name: 'tenant', signal });
  });

  it('leaves out runtimes the host does not allow', async () => {
    const { run } = setup({ limits: { runtimes: ['aws.lambda'] } });

    const { structuredContent } = await run();

    expect(structuredContent.sandboxes.map(({ runtime }) => runtime)).toEqual(['aws.lambda']);
  });

  it('only reads', () => {
    expect(setup().tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});
