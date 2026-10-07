import * as vscode from 'vscode';
import { ActiveRecordTracker } from './ActiveRecordTracker';
import { EditsInFlight } from './followRecord';
import { FocusedCells, GRID_VIEW, publishFocusedCell, gridCopyValueText } from './focusedCells';
import { announceConflictsComputed } from './notificationWiring';
import { registerEditorCommands, type EditorCommandDeps } from './recordPanelHost';
import { REFERENCED_BY_VIEW, allHolders, referencedByCopyValueText } from './ReferencedByTreeProvider';
import { createReferencedByView } from './referencedByView';
import { registerNameFilter, type NameFilter } from '../drivingLib/nameFilter';
import { selectionInFocusedView } from '../drivingLib/inFocusedView';
import type { CopyValueAdapter } from '../drivingLib/copyValue';
import type { FocusedView } from '../drivingLib/focusedView';

type EditorDeps = Omit<EditorCommandDeps,
  'recordPanels' | 'activeRecordTracker' | 'editsInFlight' | 'focusedCells' | 'focusedViewSelection' | 'selectionOf' | 'meditClient'
> & {
  meditClient: EditorCommandDeps['meditClient'] & Parameters<typeof createReferencedByView>[0];
  focusedView: FocusedView;
  /** The other views whose selected rows carry a record Argument. */
  recordViewIds: readonly string[];
};

export interface Editor extends vscode.Disposable {
  announceConflictsComputed(): void;
  nameFilters: ReadonlyMap<string, Pick<NameFilter, 'open' | 'clear'>>;
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
  const recordPanels = new Set<vscode.WebviewPanel>();
  const activeRecordTracker = new ActiveRecordTracker<vscode.WebviewPanel>();
  const editsInFlight = new EditsInFlight(activeRecordTracker);
  const focusedCells = new FocusedCells<vscode.WebviewPanel>(
    () => activeRecordTracker.activePanel(),
    (cell) => { publishFocusedCell(cell, setContext); },
    () => focusedView.enter(GRID_VIEW));

  const referencedBy = own(createReferencedByView(deps.meditClient, (msg) => deps.outputChannel.info(msg), registerNameFilter));
  const { provider: referencedByTree, view: referencedByView } = referencedBy;
  own(focusedView.follow(REFERENCED_BY_VIEW, referencedByView));
  own(referencedByView.onDidChangeSelection(() => {
    setContext('modbench.referencedBy.allHolders', allHolders(referencedByView.selection));
  }));
  own(activeRecordTracker.onDidChangeActiveRecord((formKey) => referencedByTree.showFor(formKey)));
  referencedByTree.showFor(activeRecordTracker.current());

  registerEditorCommands({
    ...deps, recordPanels, activeRecordTracker, editsInFlight, focusedCells, selectionOf: (view) => focusedView.selectionOf(view),
    focusedViewSelection: selectionInFocusedView(own, focusedView, [REFERENCED_BY_VIEW, ...deps.recordViewIds], 'modbench.record.selectionIn'),
  }).forEach(own);

  return {
    announceConflictsComputed: () => { announceConflictsComputed(recordPanels, editsInFlight); },
    nameFilters: new Map([[REFERENCED_BY_VIEW, referencedBy.filter]]),
    copyValue: [
      { text: gridCopyValueText(() => focusedCells.current()), reporterTag: 'recordGrid.copy' },
      { text: (clicked, allSelected) => referencedByCopyValueText(referencedByView, clicked, allSelected), reporterTag: 'referencedByTree.copy' },
    ],
    dispose: () => { owned.splice(0).reverse().forEach((disposable) => { disposable.dispose(); }); },
  };
}
