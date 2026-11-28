import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clipboard, commandHandlers, editorVscode, executed } from './editorVscode';

vi.mock('vscode', () => editorVscode);

import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type FocusedCellContext } from '../../wire/messages';
import { present } from '../../ports/present';
import { editorOver, forgetEditor } from './editorHarness';

const IDENTITY = { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA' };
const LEVEL = [{ kind: 'member', name: 'Level' }];

const editableCell = (holdsValue: boolean) => ({
  webviewSection: 'cell editableCell', copyText: '7', ...IDENTITY, path: LEVEL, holdsValue,
});

function registered(cell: FocusedCellContext) {
  const tab = editorOver().open('000801:A.esp');
  tab.receive({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: cell, entered: true });
  for (const command of ['modbench.record.editField', 'modbench.record.cut']) commandHandlers.set(command, () => undefined);
  const run = (command: string) => present(commandHandlers.get(command), command)();
  const told = () => tab.webview.postMessage.mock.calls.map(([message]: unknown[]) => message);
  return { told, run };
}

beforeEach(forgetEditor);

describe('the record grid\'s key entry points', () => {
  it('F2 asks the panel in focus to open its focused cell\'s editor', async () => {
    const { told, run } = registered(editableCell(true));
    await run('modbench.recordGrid.editHere');
    expect(told()).toEqual([{ type: EXTENSION_TO_WEBVIEW.OPEN_CELL_EDITOR }]);
    expect(executed()).toEqual([]);
  });

  it('Ctrl+V hands the panel in focus the clipboard\'s text for its focused cell', async () => {
    clipboard.readText.mockResolvedValue('12');
    const { told, run } = registered(editableCell(true));
    await run('modbench.recordGrid.pasteHere');
    expect(told()).toEqual([{ type: EXTENSION_TO_WEBVIEW.PASTE_INTO_CELL, text: '12' }]);
  });

  it('Delete on a field that is not an element sets it to nothing, through edit field, on the focused cell\'s plugin copy', async () => {
    const { run } = registered(editableCell(true));
    await run('modbench.recordGrid.clearHere');
    expect(executed()).toEqual([
      ['modbench.record.editField', IDENTITY, { op: 'set', path: LEVEL, value: null }],
    ]);
  });

  it('Ctrl+X fires cut on the focused cell', async () => {
    const { run } = registered(editableCell(true));
    await run('modbench.recordGrid.cutHere');
    expect(executed()).toEqual([['modbench.record.cut']]);
  });

  it.each([
    ['Delete', 'a field the plugin does not hold', 'clearHere', editableCell(false)],
    ['Delete', 'a cell that cannot be edited', 'clearHere', { webviewSection: 'cell', copyText: '7' }],
  ])('%s on %s changes nothing', async (_key, _what, command, cell) => {
    const { run } = registered(cell);
    await run(`modbench.recordGrid.${command}`);
    expect(executed()).toEqual([]);
  });
});
