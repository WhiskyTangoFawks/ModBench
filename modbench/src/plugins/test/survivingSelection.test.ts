import { describe, it, expect } from 'vitest';
import { survivingSelection } from '../survivingSelection';

interface Row { id: string }

function fakeView(initial: readonly Row[] = []) {
  const listeners: ((e: { selection: readonly Row[] }) => void)[] = [];
  const view = {
    selection: initial,
    onDidChangeSelection: (listener: (e: { selection: readonly Row[] }) => void) => {
      listeners.push(listener);
      return { dispose: () => { listeners.splice(listeners.indexOf(listener), 1); } };
    },
  };
  return {
    view,
    select: (rows: readonly Row[]) => {
      view.selection = rows;
      for (const listener of listeners) listener({ selection: rows });
    },
    rebuildFiringNoEvent: () => { view.selection = []; },
    rowsReturned: (rows: readonly Row[]) => { view.selection = rows; },
  };
}

describe('survivingSelection', () => {
  it('answers the view\'s selection', () => {
    const { view, select } = fakeView();
    const selection = survivingSelection(view);

    select([{ id: 'a' }]);

    expect(selection.rows()).toEqual([{ id: 'a' }]);
  });

  it('keeps the selection while a rebuilt tree has not handed its rows back', () => {
    const { view, select, rebuildFiringNoEvent } = fakeView();
    const selection = survivingSelection(view);
    select([{ id: 'a' }]);

    rebuildFiringNoEvent();

    expect(selection.rows()).toEqual([{ id: 'a' }]);
  });

  it('answers the view\'s selection once the tree has handed its rows back', () => {
    const { view, select, rebuildFiringNoEvent, rowsReturned } = fakeView();
    const selection = survivingSelection(view);
    select([{ id: 'a' }]);
    rebuildFiringNoEvent();

    rowsReturned([{ id: 'b' }]);

    expect(selection.rows()).toEqual([{ id: 'b' }]);
  });

  it('answers nothing once the user has cleared the selection', () => {
    const { view, select } = fakeView();
    const selection = survivingSelection(view);
    select([{ id: 'a' }]);

    select([]);

    expect(selection.rows()).toEqual([]);
  });

  it('starts from the selection the view already holds', () => {
    const { view, rebuildFiringNoEvent } = fakeView([{ id: 'a' }]);
    const selection = survivingSelection(view);

    rebuildFiringNoEvent();

    expect(selection.rows()).toEqual([{ id: 'a' }]);
  });

  it('stops listening when disposed', () => {
    const { view, select } = fakeView();
    const selection = survivingSelection(view);
    selection.dispose();

    select([{ id: 'a' }]);
    view.selection = [];

    expect(selection.rows()).toEqual([]);
  });
});
