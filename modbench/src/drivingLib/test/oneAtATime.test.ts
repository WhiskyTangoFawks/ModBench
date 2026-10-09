import { describe, it, expect } from 'vitest';
import { oneAtATime } from '../oneAtATime';

describe('one at a time', () => {
  it('starts each job after the one before it settles, even when that one failed', async () => {
    const run = oneAtATime();
    const log: string[] = [];
    let fail: (error: Error) => void = () => undefined;
    const first = run(() => new Promise<never>((_, reject) => { fail = reject; }));
    const second = run(() => { log.push('second starts'); return Promise.resolve('done'); });

    await Promise.resolve();
    expect(log).toEqual([]);
    fail(new Error('no'));

    await expect(first).rejects.toThrow('no');
    expect(await second).toBe('done');
    expect(log).toEqual(['second starts']);
  });
});
