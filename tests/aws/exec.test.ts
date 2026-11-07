import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { from, lastValueFrom, switchMap, toArray } from 'rxjs';
import { Exec, ExecFinished, ExecFrame } from '../../src/api/types';
import { execOf, RETAINED } from '../../src/aws/exec';
import { EXEC_STREAM } from '../../src/proxy/shell';

const out = (text: string): ExecFrame => ({ stream: EXEC_STREAM.STDOUT, payload: Buffer.from(text) });
const err = (text: string): ExecFrame => ({ stream: EXEC_STREAM.STDERR, payload: Buffer.from(text) });
const exit: ExecFrame = { stream: EXEC_STREAM.EXIT, payload: Buffer.from('{"code":0}') };

const finished = (...frames: ExecFrame[]): Promise<ExecFinished> =>
  lastValueFrom(execOf('c', from([...frames, exit])).pipe(switchMap((exec: Exec) => exec.wait())));

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

    const exec = await lastValueFrom(execOf('c', from([...frames, exit])));
    const replayed = await lastValueFrom(exec.frames.pipe(toArray()));

    expect(replayed).toHaveLength(32);
    expect(replayed[replayed.length - 1]).toEqual(exit);
  });
});
