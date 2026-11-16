import { describe, expect, it } from 'vitest';
import { Cancelled, untilCaughtUp } from '../untilCaughtUp';

const answeredIn = async (promise: Promise<unknown>): Promise<boolean> => {
  let answered = false;
  void promise.then(() => { answered = true; }, () => { answered = true; });
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  return answered;
};

describe('waiting until the problems have caught up', () => {
  it('answers once the feeds have settled', async () => {
    let settle!: () => void;
    const waited = untilCaughtUp(() => new Promise<void>((resolve) => { settle = resolve; }), new AbortController().signal);

    expect(await answeredIn(waited)).toBe(false);
    settle();

    await waited;
  });

  it('stops waiting on feeds that never settle when the request is cancelled', async () => {
    const cancel = new AbortController();
    const waited = untilCaughtUp(() => new Promise<void>(() => undefined), cancel.signal);
    const rejection = expect(waited).rejects.toBeInstanceOf(Cancelled);

    cancel.abort();

    await rejection;
  });

  it('asks nothing of the feeds for a request already cancelled', async () => {
    const cancel = new AbortController();
    cancel.abort();
    let asked = false;

    await expect(untilCaughtUp(() => { asked = true; return Promise.resolve(); }, cancel.signal)).rejects.toBeInstanceOf(Cancelled);

    expect(asked).toBe(false);
  });
});
