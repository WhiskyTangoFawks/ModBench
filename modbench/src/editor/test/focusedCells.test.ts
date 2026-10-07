import { describe, it, expect, vi } from 'vitest';
import { TreeItem } from '../../test/vscodeMock';
import { copyValueVscode } from '../../drivingLib/test/copyValueHarness';

vi.mock('vscode', () => ({ ...copyValueVscode, TreeItem }));

import { GRID_VIEW, gridCopyValueText, publishFocusedCell } from '../focusedCells';

const element = { webviewSection: 'arrayElement', canMoveUp: false, canMoveDown: true };

const published = (cell: Parameters<typeof publishFocusedCell>[0]) => {
  const keys: Record<string, unknown> = {};
  publishFocusedCell(cell, (key, value) => { keys[key] = value; });
  return keys;
};

describe('publishing the focused cell as context keys', () => {
  it('sets the keys the field gestures\' palette entries read, under modbench.record.', () => {
    expect(published(element)).toEqual({
      'modbench.record.focusedCellSection': 'arrayElement', 'modbench.record.focusedCellCanMoveUp': false,
      'modbench.record.focusedCellCanMoveDown': true, 'modbench.record.focusedCellCopies': false,
      'modbench.record.focusedCellEditorOpen': false,
    });
    expect(published(undefined)).toEqual({
      'modbench.record.focusedCellSection': undefined, 'modbench.record.focusedCellCanMoveUp': false,
      'modbench.record.focusedCellCanMoveDown': false, 'modbench.record.focusedCellCopies': false,
      'modbench.record.focusedCellEditorOpen': false,
    });
  });

  it('sets the keys the grid\'s keys read: whether the cell has text to copy, and whether its editor is open', () => {
    expect(published({ webviewSection: 'cell', copyText: '7', editorOpen: true })).toMatchObject({
      'modbench.record.focusedCellCopies': true, 'modbench.record.focusedCellEditorOpen': true,
    });
    expect(published({ webviewSection: 'cell', copyText: '' })).toMatchObject({
      'modbench.record.focusedCellCopies': false, 'modbench.record.focusedCellEditorOpen': false,
    });
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
