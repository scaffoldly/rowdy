import { CloudWatchLogsClient, FilterLogEventsCommand, StartLiveTailCommand } from '@aws-sdk/client-cloudwatch-logs';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { from, lastValueFrom, switchMap, toArray } from 'rxjs';
import { Exec, ExecFinished, ExecFrame, ExecOutputOptions } from '../../src/api/types';
import { EXEC_OUTPUT, execOf, execOutput, RETAINED } from '../../src/aws/exec';
import { EXEC_LOG, EXEC_STREAM } from '../../src/proxy/shell';
import { SandboxError } from '../../src/sandbox/internal/compute';

const out = (text: string): ExecFrame => ({ stream: EXEC_STREAM.STDOUT, payload: Buffer.from(text) });
const err = (text: string): ExecFrame => ({ stream: EXEC_STREAM.STDERR, payload: Buffer.from(text) });
const exit: ExecFrame = { stream: EXEC_STREAM.EXIT, payload: Buffer.from('{"code":0}') };

const finished = (...frames: ExecFrame[]): Promise<ExecFinished> =>
  lastValueFrom(execOf(() => 'c', from([...frames, exit])).pipe(switchMap((exec: Exec) => exec.wait())));

describe('execOf', () => {
  const { bytes } = RETAINED;

  beforeEach(() => {
    RETAINED.bytes = 8;
  });

  afterEach(() => {
    RETAINED.bytes = bytes;
  });

  it('keeps what fits, and says nothing was cut', async () => {
    const done = await finished(out('hello'), err('oops'));

    await expect(done.stdout()).resolves.toBe('hello');
    await expect(done.stderr()).resolves.toBe('oops');
    expect(done.truncated).toBe(false);
  });

  it('keeps output exactly at the limit', async () => {
    const done = await finished(out('12345678'));

    await expect(done.stdout()).resolves.toBe('12345678');
    expect(done.truncated).toBe(false);
  });

  it('keeps the end of stdout across frames', async () => {
    const done = await finished(out('aaaaaaaa'), out('bbbb'), out('cc'));

    await expect(done.stdout()).resolves.toBe('aabbbbcc');
    expect(done.truncated).toBe(true);
  });

  it('keeps the end of stderr too', async () => {
    const done = await finished(err('aaaaaaaaaa'), err('b'));

    await expect(done.stderr()).resolves.toBe('aaaaaaab');
    expect(done.truncated).toBe(true);
  });

  it('limits each stream on its own', async () => {
    const done = await finished(out('12345678'), err('abcdefgh'));

    expect(done.truncated).toBe(false);
  });

  it('stays bounded through a long command', async () => {
    const done = await finished(...Array.from({ length: 10000 }, () => out('x'.repeat(100))));

    await expect(done.stdout()).resolves.toHaveLength(8);
    expect(done.truncated).toBe(true);
  });

  it('replays recent frames to a late subscriber, and no more', async () => {
    const frames = Array.from({ length: 100 }, (_, index) => out(`${index}`));

    const exec = await lastValueFrom(execOf(() => 'c', from([...frames, exit])));
    const replayed = await lastValueFrom(exec.frames.pipe(toArray()));

    expect(replayed).toHaveLength(32);
    expect(replayed[replayed.length - 1]).toEqual(exit);
  });
});

describe('execOutput', () => {
  const GROUP = 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda-microvms/sandbox';
  const locator = {
    logGroupIdentifiers: [GROUP],
    logStreamNamePrefixes: ['2026/11/07[1.0]mvm-1'],
    logEventFilterPattern: '"rowdy.exec" "cmd-1"',
  };
  const cmdId = (input: unknown = locator): string => Buffer.from(JSON.stringify(input)).toString('base64url');

  const event = (seq: number, stream: number, text: string, extra = {}) => ({
    timestamp: 1000 + seq,
    message: JSON.stringify({
      [EXEC_LOG.key]: { cmd: 'cmd-1', seq, stream, data: Buffer.from(text).toString('base64'), ...extra },
    }),
  });
  const stdout = (seq: number, text: string) => event(seq, EXEC_STREAM.STDOUT, text);
  const stderr = (seq: number, text: string) => event(seq, EXEC_STREAM.STDERR, text);
  const exited = (seq: number, code = 0) => event(seq, EXEC_STREAM.EXIT, JSON.stringify({ code }));

  type Send = (command: unknown) => Promise<unknown>;
  const mock = (send: Send) => jest.spyOn(CloudWatchLogsClient.prototype, 'send').mockImplementation(send as never);

  const history = (...pages: unknown[][]) => {
    const queue = pages.map((events, index) => ({
      events,
      nextToken: index < pages.length - 1 ? `page-${index}` : undefined,
    }));
    return mock(async () => queue.shift());
  };

  const read = (options?: ExecOutputOptions, id = cmdId()) => lastValueFrom(execOutput(GROUP, id, options));

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads past empty pages to the end', async () => {
    const send = history([], [], [stdout(0, 'out'), stderr(1, 'err')], [], [exited(2, 3)]);

    await expect(read()).resolves.toEqual({ text: 'outerr', cursor: '1001.2', exitCode: 3, dropped: false });
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('asks for only this command in its stream', async () => {
    const send = history([]);

    await read();

    const [command] = send.mock.calls[0] as unknown as [FilterLogEventsCommand];
    expect(command).toBeInstanceOf(FilterLogEventsCommand);
    expect(command.input).toMatchObject({
      logGroupIdentifier: GROUP,
      logStreamNamePrefix: locator.logStreamNamePrefixes[0],
      filterPattern: locator.logEventFilterPattern,
    });
  });

  it('reads on from a cursor, from its time', async () => {
    const send = history([stdout(1, 'seen'), stdout(2, 'new')]);

    await expect(read({ cursor: '1001.2' })).resolves.toMatchObject({ text: 'new', cursor: '1002.3' });
    expect((send.mock.calls[0] as unknown as [FilterLogEventsCommand])[0].input.startTime).toBe(1001);
  });

  it('keeps one stream, moving the cursor past the other', async () => {
    history([stdout(0, 'out'), stderr(1, 'err')]);

    await expect(read({ stream: 'stderr' })).resolves.toMatchObject({ text: 'err', cursor: '1001.2' });
  });

  it('still has the exit when read again from the end', async () => {
    history([stdout(0, 'out'), exited(1)]);
    const { cursor } = await read();

    history([stdout(0, 'out'), exited(1)]);
    await expect(read({ cursor })).resolves.toEqual({ text: '', cursor, exitCode: 0, dropped: false });
  });

  it('stops at a gap, so nothing is skipped', async () => {
    history([stdout(0, 'one'), stdout(2, 'three')]);

    await expect(read()).resolves.toMatchObject({ text: 'one', cursor: '1000.1', exitCode: undefined });
  });

  it('puts frames back in order', async () => {
    history([stdout(1, 'two'), stdout(0, 'one')]);

    await expect(read()).resolves.toMatchObject({ text: 'onetwo' });
  });

  it('stops before the limit, and reads on from there', async () => {
    const big = 'x'.repeat(EXEC_OUTPUT.limit - 1);
    history([stdout(0, big), stdout(1, 'yy'), exited(2)]);

    await expect(read()).resolves.toMatchObject({ text: big, cursor: '1000.1', exitCode: undefined });
  });

  it('says when the log dropped output', async () => {
    history([stdout(0, 'out'), event(1, EXEC_STREAM.STDOUT, '', { dropped: true }), exited(2)]);

    await expect(read()).resolves.toMatchObject({ text: 'out', dropped: true });
  });

  it('skips a line that is not a frame', async () => {
    history([{ message: 'START RequestId: cmd-1' }, { message: '{"other":1}' }, stdout(0, 'out')]);

    await expect(read()).resolves.toMatchObject({ text: 'out' });
  });

  describe('a cmd_id from outside', () => {
    it.each([
      ['another log group', cmdId({ ...locator, logGroupIdentifiers: [`${GROUP}-other`] })],
      ['this and another log group', cmdId({ ...locator, logGroupIdentifiers: [GROUP, `${GROUP}-other`] })],
      ['no log group', cmdId({})],
      ['a group that is not a list', cmdId({ logGroupIdentifiers: GROUP })],
      ['null', cmdId(null)],
      ['not JSON', 'not-a-locator'],
    ])('refuses %s, before reaching AWS', async (_name, id) => {
      const send = history([]);

      await expect(read({}, id)).rejects.toBeInstanceOf(SandboxError);
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('refuses a cursor it did not give', async () => {
    const send = history([]);

    await expect(read({ cursor: 'nonsense' })).rejects.toBeInstanceOf(SandboxError);
    expect(send).not.toHaveBeenCalled();
  });

  describe('with a timeout', () => {
    async function* session(...updates: unknown[]): AsyncGenerator<unknown> {
      yield { sessionStart: {} };
      yield* updates;
      await new Promise(() => {});
    }
    const update = (...sessionResults: unknown[]) => ({ sessionUpdate: { sessionResults } });

    const tailing = (events: unknown[], ...updates: unknown[]) =>
      mock(async (command) =>
        command instanceof StartLiveTailCommand ? { responseStream: session(...updates) } : { events }
      );

    it('tails with the locator, and ends at the exit', async () => {
      const send = tailing([stdout(0, 'one')], update(stdout(1, 'two')), update(exited(2, 4)));

      await expect(read({ timeout: 5000 })).resolves.toMatchObject({ text: 'onetwo', exitCode: 4 });
      const [command] = send.mock.calls[0] as unknown as [StartLiveTailCommand];
      expect(command).toBeInstanceOf(StartLiveTailCommand);
      expect(command.input).toEqual(locator);
    });

    it('counts a frame seen by history and the tail once', async () => {
      tailing([stdout(0, 'one'), stdout(1, 'two')], update(stdout(0, 'one'), stdout(1, 'two')), update(exited(2)));

      await expect(read({ timeout: 5000 })).resolves.toMatchObject({ text: 'onetwo', exitCode: 0 });
    });

    it('answers with what it has when time runs out', async () => {
      tailing([stdout(0, 'one')]);

      await expect(read({ timeout: 20 })).resolves.toMatchObject({ text: 'one', exitCode: undefined });
    });

    it('cancels the tail when it ends', async () => {
      const send = tailing([], update(exited(0)));

      await read({ timeout: 5000 });

      const [, options] = send.mock.calls[0] as unknown as [unknown, { abortSignal: AbortSignal }];
      expect(options.abortSignal.aborted).toBe(true);
    });
  });
});
