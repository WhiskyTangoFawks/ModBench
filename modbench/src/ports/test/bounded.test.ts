import { describe, it, expect } from 'vitest';
import { bounded } from '../bounded';

const turn = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function slowRuns() {
  const started: number[] = [];
  const finish: (() => void)[] = [];
  const run = (id: number) => () => {
    started.push(id);
    return new Promise<number>((resolve) => { finish.push(() => { resolve(id); }); });
  };
  return { run, started, finish };
}

describe('bounded', () => {
  it('starts no more runs than its limit, and the next as one finishes, in the order asked', async () => {
    const { run, started, finish } = slowRuns();
    const inTurn = bounded(2);

    const results = [0, 1, 2, 3].map((id) => inTurn(run(id)));
    await turn();
    expect(started).toEqual([0, 1]);

    finish[0]?.();
    await turn();
    expect(started).toEqual([0, 1, 2]);

    finish[1]?.(); finish[2]?.();
    await turn();
    finish[3]?.();
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3]);
  });

  it('frees its place when a run fails, and passes the failure to its caller', async () => {
    const inTurn = bounded(1);

    const failed = inTurn(() => Promise.reject(new Error('boom')));
    const next = inTurn(() => Promise.resolve('next'));

    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('next');
  });
});
