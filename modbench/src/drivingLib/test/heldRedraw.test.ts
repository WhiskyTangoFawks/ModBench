import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ EventEmitter }));

import { DecorationRedrawEmitter, holdRedraws, RedrawEmitter, releaseRedraws } from '../heldRedraw';

const MINE = 'modbench.mine';

const watched = <E>(emitter: { readonly event: (listener: (row: E) => void) => unknown }) => {
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

  it('draws another view at once while a gesture writes from one (A view, stories 2 and 14)', () => {
    const other = new RedrawEmitter<string | undefined>('modbench.other');
    const fired = watched(other);

    holdRedraws(MINE);
    other.fire('a');
    const firedWhileHeld = [...fired];
    releaseRedraws(MINE);

    expect(firedWhileHeld).toEqual(['a']);
  });

  it('holds each row asked while held, and draws it once when released', () => {
    const emitter = new RedrawEmitter<string | undefined>(MINE);
    const fired = watched(emitter);

    holdRedraws(MINE);
    emitter.fire('a');
    emitter.fire('b');
    emitter.fire('a');
    const firedWhileHeld = [...fired];
    releaseRedraws(MINE);

    expect([firedWhileHeld, fired]).toEqual([[], ['a', 'b']]);
  });

  it('draws the whole view once when the whole was asked among the rows', () => {
    const emitter = new RedrawEmitter<string | null | undefined>(MINE);
    const fired = watched(emitter);

    holdRedraws(MINE);
    emitter.fire('a');
    emitter.fire(null);
    emitter.fire('b');
    releaseRedraws(MINE);

    expect(fired).toEqual([null]);
  });

  it('holds until the last hold on the view is released', () => {
    const emitter = new RedrawEmitter<string | undefined>(MINE);
    const fired = watched(emitter);

    holdRedraws(MINE);
    holdRedraws(MINE);
    emitter.fire('a');
    releaseRedraws(MINE);
    const firedAfterOne = [...fired];
    releaseRedraws(MINE);

    expect([firedAfterOne, fired]).toEqual([[], ['a']]);
  });

  it('restores a row at once while held, and still draws what it held when released', () => {
    const emitter = new RedrawEmitter<string | undefined>(MINE);
    const fired = watched(emitter);

    holdRedraws(MINE);
    emitter.fire('a');
    emitter.restore(['b']);
    const firedWhileHeld = [...fired];
    releaseRedraws(MINE);

    expect([firedWhileHeld, fired]).toEqual([['b'], ['b', 'a']]);
  });

  it('draws nothing a disposed view held', () => {
    const emitter = new RedrawEmitter<string | undefined>(MINE);
    const fired = watched(emitter);

    holdRedraws(MINE);
    emitter.fire('a');
    emitter.dispose();
    releaseRedraws(MINE);

    expect(fired).toEqual([]);
  });

  it('asks for every decoration asked while held in one event, each file once', () => {
    const emitter = new DecorationRedrawEmitter(MINE);
    const fired = watched(emitter);
    const [a, b] = [Uri.file('/a'), Uri.file('/b')];

    holdRedraws(MINE);
    emitter.fire([a]);
    emitter.fire(b);
    emitter.fire([Uri.file('/a'), b]);
    releaseRedraws(MINE);

    expect(fired).toEqual([[a, b]]);
  });
});
