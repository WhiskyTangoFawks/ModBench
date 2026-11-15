import { describe, expect, it, vi } from 'vitest';
import { untilCaughtUp } from '../untilCaughtUp';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { EMPTY_SNAPSHOT, loadOrderStatusEventFixture } from '../../client/test/fixtures';

function lateIndex() {
  const mEdit = new InMemoryMEditClient();
  mEdit.setStatus('running');
  let answer!: () => void;
  mEdit.answerPuts(() => new Promise((resolve) => { answer = () => { resolve({ outcome: 'abandoned' }); }; }));
  void mEdit.sendLoadOrder(EMPTY_SNAPSHOT);
  return { mEdit, answer: () => { answer(); } };
}

const answeredIn = async (promise: Promise<unknown>): Promise<boolean> => {
  let answered = false;
  void promise.then(() => { answered = true; }, () => { answered = true; });
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  return answered;
};

describe('waiting until the problems have caught up with what mEdit named', () => {
  it('answers at once when the feeds are settled and the record index is not late', async () => {
    const waited = untilCaughtUp({ mEdit: new InMemoryMEditClient(), problemsCaughtUp: () => Promise.resolve() }, new AbortController().signal);

    expect(await answeredIn(waited)).toBe(true);
  });

  it('waits for the feeds to settle', async () => {
    let settle!: () => void;
    const problemsCaughtUp = () => new Promise<void>((resolve) => { settle = resolve; });
    const waited = untilCaughtUp({ mEdit: new InMemoryMEditClient(), problemsCaughtUp }, new AbortController().signal);

    expect(await answeredIn(waited)).toBe(false);
    settle();

    await waited;
  });

  it('waits while the record index may be late, then for the feeds again', async () => {
    const { mEdit, answer } = lateIndex();
    let asked = 0;
    const waited = untilCaughtUp({ mEdit, problemsCaughtUp: () => { asked += 1; return Promise.resolve(); } }, new AbortController().signal);
    expect(await answeredIn(waited)).toBe(false);

    answer();
    mEdit.emit(loadOrderStatusEventFixture({ state: 'Ready', conflictsComputed: true, version: 1 }));

    await waited;
    await vi.waitFor(() => { expect(mEdit.recordIndexMayBeLate).toBe(false); });
    expect(asked).toBeGreaterThan(1);
  });

  it('stops waiting on a late record index when the request is cancelled', async () => {
    const { mEdit } = lateIndex();
    const cancel = new AbortController();
    const waited = untilCaughtUp({ mEdit, problemsCaughtUp: () => Promise.resolve() }, cancel.signal);
    const rejection = expect(waited).rejects.toThrow('cancelled');
    await answeredIn(waited);

    cancel.abort();

    await rejection;
  });

  it('stops waiting on feeds that never settle when the request is cancelled', async () => {
    const cancel = new AbortController();
    const waited = untilCaughtUp({ mEdit: new InMemoryMEditClient(), problemsCaughtUp: () => new Promise<void>(() => undefined) }, cancel.signal);
    const rejection = expect(waited).rejects.toThrow('cancelled');

    cancel.abort();

    await rejection;
  });
});
