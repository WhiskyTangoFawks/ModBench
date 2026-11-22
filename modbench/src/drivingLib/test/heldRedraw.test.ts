import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ EventEmitter }));

import { drawn, holdingRedraws, RedrawEmitter, undrawn } from '../heldRedraw';

const watched = <E>(emitter: RedrawEmitter<E>) => {
  const fired: E[] = [];
  emitter.event((row) => { fired.push(row); });
  return fired;
};

describe('a view\'s redraw while a gesture writes (common.md, A gesture that writes, story 1)', () => {
  it('draws at once while no gesture writes', () => {
    const emitter = new RedrawEmitter<string | undefined>();
    const fired = watched(emitter);

    emitter.fire('a');

    expect(fired).toEqual(['a']);
  });

  it('holds each row asked while a gesture writes, and draws it once when the gesture ends', async () => {
    const emitter = new RedrawEmitter<string | undefined>();
    const fired = watched(emitter);
    let firedWhileWriting: (string | undefined)[] = [];

    await holdingRedraws(() => {
      for (const row of ['a', 'b', 'a']) emitter.fire(row);
      firedWhileWriting = [...fired];
      return Promise.resolve();
    });

    expect([firedWhileWriting, fired]).toEqual([[], ['a', 'b']]);
  });

  it('draws the whole view once when the whole was asked among the rows', async () => {
    const emitter = new RedrawEmitter<string | null | undefined>();
    const fired = watched(emitter);

    await holdingRedraws(() => {
      for (const row of ['a', null, 'b']) emitter.fire(row);
      return Promise.resolve();
    });

    expect(fired).toEqual([null]);
  });

  it('holds until the outermost gesture ends', async () => {
    const emitter = new RedrawEmitter<string | undefined>();
    const fired = watched(emitter);
    let firedAfterInner: (string | undefined)[] = [];

    await holdingRedraws(async () => {
      await holdingRedraws(() => { emitter.fire('a'); return Promise.resolve(); });
      firedAfterInner = [...fired];
    });

    expect([firedAfterInner, fired]).toEqual([[], ['a']]);
  });

  it('draws once the gesture ends though it failed, and lets the failure through', async () => {
    const emitter = new RedrawEmitter<string | undefined>();
    const fired = watched(emitter);

    await expect(holdingRedraws(() => { emitter.fire('a'); throw new Error('half written'); })).rejects.toThrow('half written');

    expect(fired).toEqual(['a']);
  });

  it('runs the newest draw a view asked while held, once, and none it took back', async () => {
    const drawsOf = { kept: [] as string[], takenBack: [] as string[] };
    const kept = {};
    const takenBack = {};

    await holdingRedraws(() => {
      drawn(kept, () => { drawsOf.kept.push('older'); });
      drawn(kept, () => { drawsOf.kept.push('newest'); });
      drawn(takenBack, () => { drawsOf.takenBack.push('drawn'); });
      undrawn(takenBack);
      return Promise.resolve();
    });

    expect(drawsOf).toEqual({ kept: ['newest'], takenBack: [] });
  });
});
