import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, jest } from '@jest/globals';
import type { SandboxFactory, SandboxSummary } from '../../../../src/sandbox';
import { listSandboxes } from '../../../../src/sandbox/internal/mcp/list-sandboxes';

const STARTED = new Date('2026-11-07T21:00:00.000Z');
const found: SandboxSummary[] = [
  {
    sandboxId: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:a-bcdf2',
    name: 'a-bcdf2',
    runtime: 'aws.microvm',
    running: true,
    startedAt: STARTED,
    stopsAt: new Date(STARTED.getTime() + 900_000),
    meta: {},
    state: 'ready',
  },
  {
    sandboxId: 'arn:aws:lambda:us-east-1:123456789012:function:b-ghjk4',
    name: 'b-ghjk4',
    runtime: 'aws.lambda',
    meta: {},
    state: 'building',
  },
];

const setup = () => {
  const list = jest.fn(async (_options: unknown) => found);
  const tool = listSandboxes;
  const sandboxes = { list } as unknown as SandboxFactory;
  const run = (input: Record<string, unknown> = {}) =>
    tool.run(sandboxes, tool.inputSchema.parse(input), {} as ServerContext);
  return { tool, run, list };
};

describe('list_sandboxes', () => {
  it('answers with each sandbox, and when a running one stops', async () => {
    const { run } = setup();

    expect((await run()).structuredContent).toEqual({
      sandboxes: [
        {
          sandbox_id: found[0]!.sandboxId,
          name: 'a-bcdf2',
          runtime: 'aws.microvm',
          running: true,
          started_at: '2026-11-07T21:00:00.000Z',
          stops_at: '2026-11-07T21:15:00.000Z',
          state: 'ready',
        },
        { sandbox_id: found[1]!.sandboxId, name: 'b-ghjk4', runtime: 'aws.lambda', state: 'building' },
      ],
    });
  });

  it('lists the runtime asked for', async () => {
    const { run, list } = setup();

    await run({ runtime: 'aws.microvm' });

    expect(list).toHaveBeenCalledWith({ runtime: 'aws.microvm' });
  });

  it('only reads', () => {
    expect(setup().tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});
