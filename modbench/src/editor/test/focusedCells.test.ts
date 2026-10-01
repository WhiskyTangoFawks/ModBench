import { describe, it, expect } from 'vitest';
import { FocusedCells, GRID_VIEW, focusedCellKeys, gridCopyValueText } from '../focusedCells';

const element = { webviewSection: 'arrayElement', canMoveUp: false, canMoveDown: true };
const text = { webviewSection: 'stringValue' };

// commands.md, Record: a field gesture from the palette acts on the focused cell of the record tab
// in focus, and is in the palette only while one has focus.
describe('the focused cell of the record tab in focus', () => {
  function tracked() {
    const shown: (object | undefined)[] = [];
    const cells = new FocusedCells<string>((cell) => shown.push(cell));
    return { cells, shown };
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
    });
    expect(focusedCellKeys(undefined)).toEqual({
      focusedCellSection: undefined, focusedCellCanMoveUp: false, focusedCellCanMoveDown: false,
    });
  });
});

// commands.md, Every view: copy value copies the grid's focused cell as its column reads it.
describe('the grid\'s copy value text', () => {
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
