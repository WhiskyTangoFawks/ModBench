import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ EventEmitter }));

import { holdingRedraws, RedrawEmitter } from '../heldRedraw';

const MINE = 'modbench.mine';

const watched = <E>(emitter: RedrawEmitter<E>) => {
  const fired: E[] = [];
  emitter.event((row) => { fired.push(row); });
  return fired;
};

describe('a view\'s redraw while a gesture writes from it (common.md, A gesture that writes, story 1)', () => {
  it('draws at once while no gesture writes from it', () => {
    const emitter = new RedrawEmitter<string | undefined>(MINE);
    const fired = watched(emitter);

    emitter.fire('a');

    expect(fired).toEqual(['a']);
  });

  it('draws another view at once while a gesture writes from one (A view, stories 2 and 14)', async () => {
    const other = new RedrawEmitter<string | undefined>('modbench.other');
    const fired = watched(other);
    let firedWhileWriting: (string | undefined)[] = [];

    await holdingRedraws(MINE, () => {
      other.fire('a');
      firedWhileWriting = [...fired];
      return Promise.resolve();
    });

    expect(firedWhileWriting).toEqual(['a']);
  });

  it('holds each row asked while a gesture writes, and draws it once when the gesture ends', async () => {
    const emitter = new RedrawEmitter<string | undefined>(MINE);
    const fired = watched(emitter);
    let firedWhileWriting: (string | undefined)[] = [];

    await holdingRedraws(MINE, () => {
      for (const row of ['a', 'b', 'a']) emitter.fire(row);
      firedWhileWriting = [...fired];
      return Promise.resolve();
    });

    expect([firedWhileWriting, fired]).toEqual([[], ['a', 'b']]);
  });

  it('draws the whole view once when the whole was asked among the rows', async () => {
    const emitter = new RedrawEmitter<string | null | undefined>(MINE);
    const fired = watched(emitter);

    await holdingRedraws(MINE, () => {
      for (const row of ['a', null, 'b']) emitter.fire(row);
      return Promise.resolve();
    });

    expect(fired).toEqual([null]);
  });

  it('holds until the outermost gesture from the view ends', async () => {
    const emitter = new RedrawEmitter<string | undefined>(MINE);
    const fired = watched(emitter);
    let firedAfterInner: (string | undefined)[] = [];

    await holdingRedraws(MINE, async () => {
      await holdingRedraws(MINE, () => { emitter.fire('a'); return Promise.resolve(); });
      firedAfterInner = [...fired];
    });

    expect([firedAfterInner, fired]).toEqual([[], ['a']]);
  });

  it('draws once the gesture ends though it failed, and lets the failure through', async () => {
    const emitter = new RedrawEmitter<string | undefined>(MINE);
    const fired = watched(emitter);

    await expect(holdingRedraws(MINE, () => { emitter.fire('a'); throw new Error('half written'); })).rejects.toThrow('half written');

    expect(fired).toEqual(['a']);
  });
});
