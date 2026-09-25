import { describe, it, expect } from 'vitest';
import { FocusedCells, focusedCellKeys } from '../focusedCells';

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
