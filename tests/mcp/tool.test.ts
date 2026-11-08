import type { ServerContext } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { safeTool, Tool, toolResult } from '../../src/mcp/tool';
import { Logger } from '../../src/log';

describe('toolResult', () => {
  const schema = z.object({ sandbox_id: z.string() });

  it('answers as text and structured content', () => {
    expect(toolResult(schema, { sandbox_id: 'id' })).toEqual({
      content: [{ type: 'text', text: '{"sandbox_id":"id"}' }],
      structuredContent: { sandbox_id: 'id' },
    });
  });

  it('throws for an answer that does not match its schema', () => {
    expect(() => toolResult(schema, { sandbox_id: 1 } as never)).toThrow();
  });

  it('drops anything its schema does not have', () => {
    const { structuredContent } = toolResult(schema, { sandbox_id: 'id', extra: 1 } as never);

    expect(structuredContent).toEqual({ sandbox_id: 'id' });
  });
});

describe('safeTool', () => {
  const failing = (describe: Parameters<typeof safeTool>[1]): Tool =>
    safeTool(
      {
        name: 'stop_sandbox',
        title: '',
        description: '',
        inputSchema: z.object({}),
        run: async () => {
          throw new Error('in 123456789012');
        },
      },
      describe
    );

  const message = async (tool: Tool): Promise<string> =>
    tool.run(undefined, {}, {} as ServerContext).then(
      () => '',
      ({ message }) => message
    );

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['retry', 'safe Retrying may help.'],
    ['ask', "safe Retrying won't help: tell the person."],
    ['none', "safe Retrying won't help."],
  ] as const)('says what to do for %s', async (remedy, expected) => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await message(failing(() => ({ message: 'safe', remedy })))).toBe(expected);
  });

  it('passes on an error another safe tool already made safe', async () => {
    const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const inner = failing(() => ({ message: 'safe', remedy: 'retry' }));

    expect(await message(safeTool(inner, () => ({ message: 'redone', remedy: 'none' })))).toBe(
      'safe Retrying may help.'
    );
    expect(warned.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('adds nothing without a remedy', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await message(failing(() => ({ message: 'safe' })))).toBe('safe');
  });

  it('leaves a working tool alone', async () => {
    const tool = safeTool(
      {
        name: 'ok',
        title: '',
        description: '',
        inputSchema: z.object({}),
        run: async () => toolResult(z.object({}), {}),
      },
      () => ({ message: '' })
    );

    await expect(tool.run(undefined, {}, {} as ServerContext)).resolves.toMatchObject({ structuredContent: {} });
  });

  it('logs the whole error', async () => {
    new Logger('test').withSink('stderr');
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

    await message(failing(() => ({ message: 'safe' })));

    expect(logged.mock.calls.flat().join(' ')).toContain('123456789012');
    new Logger('test').withSink(undefined);
  });
});
