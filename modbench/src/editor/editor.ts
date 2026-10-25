import * as vscode from 'vscode';
import { RecordTabs } from './recordTabs';
import { GRID_VIEW, publishFocusedCell, gridCopyValueText } from './focusedCells';
import { registerNoConflictLens } from './noConflictLens';
import { registerEditorCommands, type EditorCommandDeps } from './editorCommands';
import { referencedByCopyValueText } from './referencedByList';
import { registerReferencedBy, type LocateRecord, type ReferencedByDeps } from './referencedBy';
import { selectionInFocusedView } from '../drivingLib/inFocusedView';
import type { CopyValueAdapter } from '../drivingLib/copyValue';
import type { FocusedView } from '../drivingLib/focusedView';

type EditorDeps = Omit<EditorCommandDeps,
  'tabs' | 'focusedViewSelection' | 'selectionOf' | 'meditClient'
> & {
  meditClient: EditorCommandDeps['meditClient'] & ReferencedByDeps['client'];
  focusedView: FocusedView;
  /** The other views whose selected rows carry a record Argument. */
  recordViewIds: readonly string[];
  locateRecord: LocateRecord;
};

export interface Editor extends vscode.Disposable {
  copyValue: readonly CopyValueAdapter[];
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

  own(registerReferencedBy({
    client: deps.meditClient, reporter: deps.reporterFor('referencedBy'),
    locateRecord: deps.locateRecord, recordInFocus: () => tabs.activeTab()?.formKey,
  }));

  registerNoConflictLens(tabs).forEach(own);

  registerEditorCommands({
    ...deps, tabs, selectionOf: (view) => focusedView.selectionOf(view),
    focusedViewSelection: selectionInFocusedView(own, focusedView, deps.recordViewIds, 'modbench.record.selectionIn'),
  }).forEach(own);

  return {
    copyValue: [
      { text: gridCopyValueText(() => tabs.focusedCell()), reporterTag: 'recordGrid.copy' },
      { text: referencedByCopyValueText, reporterTag: 'referencedBy.copy' },
    ],
    dispose: () => { owned.splice(0).reverse().forEach((disposable) => { disposable.dispose(); }); },
  };
}
