import * as vscode from 'vscode';
import { EXTENSION_TO_WEBVIEW, hasSection, type EditableCellContext, type ExtensionToWebview } from '../wire/messages';
import { GRID_VIEW, type FocusedCellContext } from './focusedCells';

export interface GridKeyCommandDeps {
  focusedCell: () => FocusedCellContext | undefined;
  tellFocusedPanel: (message: ExtensionToWebview) => void;
}

function isEditableCell(cell: FocusedCellContext | undefined): cell is EditableCellContext {
  return cell !== undefined && hasSection(cell, 'editableCell')
    && ['formKey', 'plugin', 'origin'].every(name => typeof Reflect.get(cell, name) === 'string')
    && Array.isArray(Reflect.get(cell, 'path')) && typeof Reflect.get(cell, 'holdsValue') === 'boolean';
}

type Firing = [command: string, ...args: unknown[]];

function clearing(cell: FocusedCellContext | undefined): Firing | undefined {
  if (!isEditableCell(cell) || !cell.holdsValue) return undefined;
  const { formKey, plugin, origin, path } = cell;
  return ['modbench.record.editField', { formKey, plugin, origin }, { op: 'set', path, value: null }];
}

// editor.md, The focused cell, story 6: Delete removes an element, and clears any other field.
function deletion(cell: FocusedCellContext | undefined): Firing | undefined {
  return hasSection(cell, 'arrayElement') ? ['modbench.record.removeElement', cell] : clearing(cell);
}

/** The grid's keys VS Code cannot hand the focused cell's Arguments. Clear and cut fire their catalog
 *  commands with them; F2 and paste reach the focused cell, which writes through edit field. */
export function registerGridKeyCommands(deps: GridKeyCommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(`${GRID_VIEW}.editHere`, () => {
      deps.tellFocusedPanel({ type: EXTENSION_TO_WEBVIEW.OPEN_CELL_EDITOR });
    }),
    vscode.commands.registerCommand(`${GRID_VIEW}.pasteHere`, async () => {
      deps.tellFocusedPanel({ type: EXTENSION_TO_WEBVIEW.PASTE_INTO_CELL, text: await vscode.env.clipboard.readText() });
    }),
    vscode.commands.registerCommand(`${GRID_VIEW}.clearHere`, async () => {
      const clear = clearing(deps.focusedCell());
      if (clear) await vscode.commands.executeCommand(...clear);
    }),
    vscode.commands.registerCommand(`${GRID_VIEW}.cutHere`, async () => {
      const deleted = deletion(deps.focusedCell());
      if (!deleted) return;
      await vscode.commands.executeCommand('modbench.copyValue', { view: GRID_VIEW });
      await vscode.commands.executeCommand(...deleted);
    }),
  ];
}
