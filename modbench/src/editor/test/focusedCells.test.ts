import { describe, it, expect, vi } from 'vitest';
import { FocusedCells, GRID_VIEW, focusedCellKeys, gridCopyValueText, publishFocusedCell } from '../focusedCells';

const element = { webviewSection: 'arrayElement', canMoveUp: false, canMoveDown: true };
const text = { webviewSection: 'stringValue' };

describe('the focused cell of the record tab in focus, which the palette\'s field gestures act on', () => {
  function tracked() {
    const shown: (object | undefined)[] = [];
    const entries: string[] = [];
    const cells = new FocusedCells<string>((cell) => shown.push(cell), () => entries.push('entered'));
    return { cells, shown, entries };
  }

  it('is the active panel\'s own focused cell, and follows the active panel', () => {
    const { cells, shown } = tracked();
    cells.setCell('A', element);
    cells.setCell('B', text);
    expect(cells.current()).toBeUndefined();

    cells.setActivePanel('A');
    expect(cells.current()).toBe(element);
    cells.setActivePanel('B');
    expect(cells.current()).toBe(text);
    expect(shown).toEqual([element, text]);
  });

  it('shows a new cell only for the active panel', () => {
    const { cells, shown } = tracked();
    cells.setActivePanel('A');
    cells.setCell('B', text);
    cells.setCell('A', element);
    expect(shown).toEqual([undefined, element]);
  });

  it('takes a cell for the panel in focus, and none while no panel is', () => {
    const { cells } = tracked();
    cells.setActiveCell(element);
    expect(cells.current()).toBeUndefined();

    cells.setActivePanel('A');
    cells.setActiveCell(text);
    expect(cells.current()).toBe(text);
  });

  it('is gone with the panel that held it', () => {
    const { cells, shown } = tracked();
    cells.setActivePanel('A');
    cells.setCell('A', element);
    cells.removePanel('A');
    expect(cells.current()).toBeUndefined();
    expect(shown.at(-1)).toBeUndefined();
  });

  it('sets the keys the field gestures\' palette entries read', () => {
    expect(focusedCellKeys(element)).toEqual({
      focusedCellSection: 'arrayElement', focusedCellCanMoveUp: false, focusedCellCanMoveDown: true,
      focusedCellCopies: false, focusedCellEditorOpen: false,
    });
    expect(focusedCellKeys(undefined)).toEqual({
      focusedCellSection: undefined, focusedCellCanMoveUp: false, focusedCellCanMoveDown: false,
      focusedCellCopies: false, focusedCellEditorOpen: false,
    });
  });

  it('sets the keys the grid\'s keys read: whether the cell has text to copy, and whether its editor is open', () => {
    expect(focusedCellKeys({ webviewSection: 'cell', copyText: '7', editorOpen: true })).toMatchObject({
      focusedCellCopies: true, focusedCellEditorOpen: true,
    });
    expect(focusedCellKeys({ webviewSection: 'cell', copyText: '' })).toMatchObject({
      focusedCellCopies: false, focusedCellEditorOpen: false,
    });
  });
});

describe('publishing the focused cell as context keys', () => {
  it('sets each key under modbench.record.', () => {
    const set = vi.fn();
    publishFocusedCell(element, set);
    expect(set).toHaveBeenCalledWith('modbench.record.focusedCellSection', 'arrayElement');
    expect(set).toHaveBeenCalledWith('modbench.record.focusedCellCanMoveDown', true);
    expect(set).toHaveBeenCalledTimes(Object.keys(focusedCellKeys(element)).length);
  });
});

describe('the record grid entering the focused view, which copy value and the name filter act on', () => {
  function tracked() {
    const entries: string[] = [];
    const cells = new FocusedCells<string>(() => undefined, () => entries.push('entered'));
    return { cells, entries };
  }

  it('enters when a cell reports a user\'s focus', () => {
    const { cells, entries } = tracked();
    cells.setActivePanel('A');
    entries.length = 0;
    cells.setCell('A', element, true);
    expect(entries).toEqual(['entered']);
  });

  it('does not enter when a re-read refreshes the cell\'s context', () => {
    const { cells, entries } = tracked();
    cells.setActivePanel('A');
    entries.length = 0;
    cells.setCell('A', element);
    cells.setCell('A', { ...element, copyText: 'changed' });
    expect(entries).toEqual([]);
  });

  it('enters when the record panel gains focus', () => {
    const { cells, entries } = tracked();
    cells.setActivePanel('A');
    expect(entries).toEqual(['entered']);
  });
});

describe('the grid\'s copy value text, the focused cell as its column reads it', () => {
  it('is the text the webview\'s Ctrl+C names', () => {
    expect(gridCopyValueText(() => ({ copyText: 'focused' }))({ copyText: 'named' })).toBe('named');
  });

  it('from the palette with the grid focused, which names no cell, is the focused cell\'s text', () => {
    expect(gridCopyValueText(() => ({ copyText: 'focused' }))({ view: GRID_VIEW })).toBe('focused');
  });

  it('is empty for a focused cell that reads empty, which is not a deferral', () => {
    expect(gridCopyValueText(() => ({ copyText: '' }))({ view: GRID_VIEW })).toBe('');
  });

  it('defers when the invocation belongs to another view, or no cell holds text', () => {
    expect(gridCopyValueText(() => ({ copyText: 'focused' }))({ view: 'modbench.modList' })).toBeUndefined();
    expect(gridCopyValueText(() => ({ copyText: 'focused' }))(undefined)).toBeUndefined();
    expect(gridCopyValueText(() => undefined)({ view: GRID_VIEW })).toBeUndefined();
    expect(gridCopyValueText(() => ({}))({ view: GRID_VIEW })).toBeUndefined();
  });
});
