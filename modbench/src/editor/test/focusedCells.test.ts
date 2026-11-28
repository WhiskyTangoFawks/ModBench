import { describe, it, expect, vi, beforeEach } from 'vitest';
import { contextKeys, editorVscode } from './editorVscode';

vi.mock('vscode', () => editorVscode);

import { WEBVIEW_TO_EXTENSION } from '../../wire/messages';
import { editorOver, forgetEditor } from './editorHarness';

beforeEach(forgetEditor);

const element = { webviewSection: 'arrayElement', canMoveUp: false, canMoveDown: true };

const keys = (section: string | undefined, canMoveUp: boolean, canMoveDown: boolean, copies: boolean, editorOpen: boolean) => ({
  'modbench.record.focusedCellSection': section, 'modbench.record.focusedCellCanMoveUp': canMoveUp,
  'modbench.record.focusedCellCanMoveDown': canMoveDown, 'modbench.record.focusedCellCopies': copies,
  'modbench.record.focusedCellEditorOpen': editorOpen,
});

const focusedCellKeys = () => Object.fromEntries([...contextKeys].filter(([key]) => key.startsWith('modbench.record.focusedCell')));

describe('publishing the focused cell as the context keys the field gestures and the grid\'s keys read', () => {
  it.each([
    ['an element that can move down', element, keys('arrayElement', false, true, false, false)],
    ['no cell', null, keys(undefined, false, false, false, false)],
    ['a cell with text to copy and its editor open', { webviewSection: 'cell', copyText: '7', editorOpen: true }, keys('cell', false, false, true, true)],
    ['a cell whose text is empty', { webviewSection: 'cell', copyText: '' }, keys('cell', false, false, false, false)],
  ])('publishes %s', (_, cell, expected) => {
    const { open } = editorOver();

    open('000801:A.esp').receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: cell, entered: false });

    expect(focusedCellKeys()).toEqual(expected);
  });
});

describe('the grid\'s copy value text, the focused cell as its column reads it', () => {
  it.each([
    ['the text the webview\'s Ctrl+C names', { copyText: 'focused' }, { copyText: 'named' }, 'named'],
    ['from the palette with the grid focused, which names no cell, the focused cell\'s text', { copyText: 'focused' }, { view: 'modbench.recordGrid' }, 'focused'],
    ['empty for a focused cell that reads empty, which is not a deferral', { copyText: '' }, { view: 'modbench.recordGrid' }, ''],
    ['a deferral when the invocation belongs to another view', { copyText: 'focused' }, { view: 'modbench.modList' }, undefined],
    ['a deferral with no invocation', { copyText: 'focused' }, undefined, undefined],
    ['a deferral with no focused cell', null, { view: 'modbench.recordGrid' }, undefined],
    ['a deferral when the focused cell holds no text', {}, { view: 'modbench.recordGrid' }, undefined],
  ])('is %s', (_, focused, invocation, text) => {
    const { editor, open } = editorOver();
    open('000801:A.esp').receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: focused && { webviewSection: 'cell', ...focused }, entered: false });

    expect(editor.copyValue.map((copy) => copy.text(invocation, undefined))).toEqual([text]);
  });
});
