import * as vscode from 'vscode';
import { RecordTabs } from './recordTabs';
import { GRID_VIEW, publishFocusedCell, gridCopyValueText } from './focusedCells';
import { registerNoConflictLens } from './noConflictLens';
import { registerEditorCommands, type EditorCommandDeps } from './editorCommands';
import { pickRecord } from './recordPicker';
import { selectionInFocusedView } from '../drivingLib/inFocusedView';
import type { CopyValueAdapter } from '../drivingLib/copyValue';
import type { FocusedView } from '../drivingLib/focusedView';

type EditorDeps = Omit<EditorCommandDeps,
  'tabs' | 'focusedViewSelection' | 'selectionOf'
> & {
  focusedView: FocusedView;
  /** The other views whose selected rows carry a record Argument. */
  recordViewIds: readonly string[];
};

export interface Editor extends vscode.Disposable {
  copyValue: readonly CopyValueAdapter[];
  /** The record of the tab in focus, else the one the user picks; undefined where none is. */
  focusedOrPickedRecord: () => Promise<string | undefined>;
}

const setContext = (key: string, value: unknown): void => {
  void vscode.commands.executeCommand('setContext', key, value);
};

export function createEditor(deps: EditorDeps): Editor {
  const { focusedView } = deps;
  const owned: vscode.Disposable[] = [];
  const own = <T extends vscode.Disposable>(disposable: T): T => {
    owned.push(disposable);
    return disposable;
  };
  const tabs = new RecordTabs((cell) => { publishFocusedCell(cell, setContext); }, () => focusedView.enter(GRID_VIEW));

  registerNoConflictLens(tabs).forEach(own);

  registerEditorCommands({
    ...deps, tabs, selectionOf: (view) => focusedView.selectionOf(view),
    focusedViewSelection: selectionInFocusedView(own, focusedView, deps.recordViewIds, 'modbench.record.selectionIn'),
  }).forEach(own);

  return {
    copyValue: [
      { text: gridCopyValueText(() => tabs.focusedCell()), reporterTag: 'recordGrid.copy' },
    ],
    focusedOrPickedRecord: async () => tabs.activeTab()?.formKey
      ?? await pickRecord({ meditClient: deps.meditClient, reporter: deps.reporterFor('recordPicker') }, '', []) ?? undefined,
    dispose: () => { owned.splice(0).reverse().forEach((disposable) => { disposable.dispose(); }); },
  };
}
