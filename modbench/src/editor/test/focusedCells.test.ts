import { describe, it, expect, vi } from 'vitest';
import { TreeItem } from '../../test/vscodeMock';
import { copyValueVscode } from '../../drivingLib/test/copyValueHarness';

vi.mock('vscode', () => ({ ...copyValueVscode, TreeItem }));

import { GRID_VIEW, focusedCellKeys, gridCopyValueText, publishFocusedCell } from '../focusedCells';

const element = { webviewSection: 'arrayElement', canMoveUp: false, canMoveDown: true };

describe('the keys the focused cell sets', () => {
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
