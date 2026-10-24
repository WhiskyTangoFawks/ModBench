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

const keys = (section: string | undefined, canMoveUp: boolean, canMoveDown: boolean, copies: boolean, editorOpen: boolean) => ({
  'modbench.record.focusedCellSection': section, 'modbench.record.focusedCellCanMoveUp': canMoveUp,
  'modbench.record.focusedCellCanMoveDown': canMoveDown, 'modbench.record.focusedCellCopies': copies,
  'modbench.record.focusedCellEditorOpen': editorOpen,
});

describe('publishing the focused cell as the context keys the field gestures and the grid\'s keys read', () => {
  it.each([
    ['an element that can move down', element, keys('arrayElement', false, true, false, false)],
    ['no cell', undefined, keys(undefined, false, false, false, false)],
    ['a cell with text to copy and its editor open', { webviewSection: 'cell', copyText: '7', editorOpen: true }, keys('cell', false, false, true, true)],
    ['a cell whose text is empty', { webviewSection: 'cell', copyText: '' }, keys('cell', false, false, false, false)],
  ])('publishes %s', (_, cell, expected) => {
    expect(published(cell)).toEqual(expected);
  });
});

describe('the grid\'s copy value text, the focused cell as its column reads it', () => {
  const focused = () => ({ copyText: 'focused' });

  it.each([
    ['the text the webview\'s Ctrl+C names', focused, { copyText: 'named' }, 'named'],
    ['from the palette with the grid focused, which names no cell, the focused cell\'s text', focused, { view: GRID_VIEW }, 'focused'],
    ['empty for a focused cell that reads empty, which is not a deferral', () => ({ copyText: '' }), { view: GRID_VIEW }, ''],
    ['a deferral when the invocation belongs to another view', focused, { view: 'modbench.modList' }, undefined],
    ['a deferral with no invocation', focused, undefined, undefined],
    ['a deferral with no focused cell', () => undefined, { view: GRID_VIEW }, undefined],
    ['a deferral when the focused cell holds no text', () => ({}), { view: GRID_VIEW }, undefined],
  ])('is %s', (_, focusedCell, invocation, text) => {
    expect(gridCopyValueText(focusedCell)(invocation)).toBe(text);
  });
});
