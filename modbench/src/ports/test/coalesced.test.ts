import { describe, it, expect } from 'vitest';
import { coalesced } from '../coalesced';

const turn = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function slowRun() {
  const started: number[] = [];
  const finish: (() => void)[] = [];
  let inFlight = 0;
  let overlapped = false;
  const run = () => {
    started.push(started.length);
    inFlight += 1;
    overlapped ||= inFlight > 1;
    return new Promise<void>((resolve) => { finish.push(() => { inFlight -= 1; resolve(); }); });
  };
  return { run, started, finish, overlapped: () => overlapped };
}

describe('coalesced', () => {
  it('runs once for the calls of one turn', async () => {
    const { run, started } = slowRun();
    const call = coalesced(run);

    call(); call(); call();
    await turn();

    expect(started).toHaveLength(1);
  });

  it('starts no second run while one is in flight, and runs once more after it for every call made meanwhile', async () => {
    const { run, started, finish, overlapped } = slowRun();
    const call = coalesced(run);
    call();
    await turn();

    call(); await turn(); call(); call();
    await turn();
    expect(started).toHaveLength(1);

    finish[0]?.();
    await turn();
    finish[1]?.();
    await turn();

    expect([started.length, overlapped()]).toEqual([2, false]);
  });

  it('runs again on a call after the run finished', async () => {
    const { run, started, finish } = slowRun();
    const call = coalesced(run);
    call();
    await turn();
    finish[0]?.();
    await turn();

    call();
    await turn();

    expect(started).toHaveLength(2);
  });
});
