import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, () => Promise<void> | void>();
const executeCommand = vi.fn<(command: string, ...args: unknown[]) => Promise<void>>();
const readText = vi.fn<() => Promise<string>>();
vi.mock('vscode', () => ({
  commands: {
    registerCommand: (command: string, handler: () => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    },
    executeCommand: (...args: [string, ...unknown[]]) => executeCommand(...args),
  },
  env: { clipboard: { readText: () => readText() } },
}));

import { registerGridKeyCommands } from '../gridKeyCommands';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from '../../wire/messages';
import type { FocusedCellContext } from '../../wire/messages';
import { present } from '../../ports/present';

const IDENTITY = { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA' };
const LEVEL = [{ kind: 'member', name: 'Level' }];

const editableCell = (holdsValue: boolean) => ({
  webviewSection: 'cell editableCell', copyText: '7', ...IDENTITY, path: LEVEL, holdsValue,
});

function registered(cell: FocusedCellContext | undefined) {
  const told: ExtensionToWebview[] = [];
  registerGridKeyCommands({ focusedCell: () => cell, tellFocusedPanel: (m) => { told.push(m); } });
  const run = (command: string) => present(handlers.get(command), command)();
  return { told, run };
}

beforeEach(() => { handlers.clear(); executeCommand.mockReset(); readText.mockReset(); });

describe('the record grid\'s key entry points', () => {
  it('F2 asks the panel in focus to open its focused cell\'s editor', async () => {
    const { told, run } = registered(editableCell(true));
    await run('modbench.recordGrid.editHere');
    expect(told).toEqual([{ type: EXTENSION_TO_WEBVIEW.OPEN_CELL_EDITOR }]);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('Ctrl+V hands the panel in focus the clipboard\'s text for its focused cell', async () => {
    readText.mockResolvedValue('12');
    const { told, run } = registered(editableCell(true));
    await run('modbench.recordGrid.pasteHere');
    expect(told).toEqual([{ type: EXTENSION_TO_WEBVIEW.PASTE_INTO_CELL, text: '12' }]);
  });

  it('Delete on a field that is not an element sets it to nothing, through edit field, on the focused cell\'s plugin copy', async () => {
    const { run } = registered(editableCell(true));
    await run('modbench.recordGrid.clearHere');
    expect(executeCommand.mock.calls).toEqual([
      ['modbench.record.editField', IDENTITY, { op: 'set', path: LEVEL, value: null }],
    ]);
  });

  it('Ctrl+X fires cut on the focused cell', async () => {
    const { run } = registered(editableCell(true));
    await run('modbench.recordGrid.cutHere');
    expect(executeCommand.mock.calls).toEqual([['modbench.record.cut']]);
  });

  it.each([
    ['Delete', 'a field the plugin does not hold', 'clearHere', editableCell(false)],
    ['Delete', 'a cell that cannot be edited', 'clearHere', { webviewSection: 'cell', copyText: '7' }],
  ])('%s on %s changes nothing', async (_key, _what, command, cell) => {
    const { run } = registered(cell);
    await run(`modbench.recordGrid.${command}`);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
