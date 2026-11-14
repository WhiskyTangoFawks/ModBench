import * as vscode from 'vscode';
import { isUri } from '../drivingLib/argument';
import type { InstanceValue } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import { samePath } from '../symbolNames/symbolNames';
import { symbolOfRow } from './rowSymbol';
import type { SymbolName } from './symbolKind';

export type FilesHeld = Pick<InstanceValue, 'filesByMod' | 'dataFolderFiles'>;

interface ReferencedByDeps {
  reporter: Pick<Reporter, 'report'>;
  referencedBy: (symbol: SymbolName) => Promise<void>;
  selection: () => readonly unknown[];
  dataPathOf: (row: unknown) => string | undefined;
  filesHeld: () => FilesHeld;
  focusedRecord: () => string | undefined;
  pick: () => Promise<SymbolName | undefined>;
}

function dataPathHolding({ filesByMod, dataFolderFiles }: FilesHeld, file: string): string | undefined {
  const inData = dataFolderFiles.kind === 'listed' ? [...dataFolderFiles.files.values()] : [];
  return [...[...filesByMod.values()].flat(), ...inData].find(({ path }) => samePath(path, file))?.relativePath;
}

/** `referenced by` (commands.md, Symbol). With no row given and none selected, it asks about the record tab in focus,
 *  else for a symbol as Go to Symbol in Workspace finds it. */
export function registerReferencedBy({ reporter, referencedBy, selection, dataPathOf, filesHeld, focusedRecord, pick }: ReferencedByDeps): vscode.Disposable {
  const refuse = (what: string, why: string): void => { reporter.report('error', `Could not list where files name ${what}.`, why); };
  return vscode.commands.registerCommand('modbench.symbol.referencedBy', async (clicked?: unknown) => {
    if (isUri(clicked)) {
      const path = dataPathHolding(filesHeld(), clicked.fsPath);
      if (path === undefined) return refuse(clicked.fsPath, 'No mod holds it, and it is not in the game\'s Data folder.');
      return referencedBy({ kind: 'file', path });
    }
    const [only, ...rest] = selection();
    const row = clicked ?? (rest.length === 0 ? only : undefined);
    if (row !== undefined) {
      const symbol = symbolOfRow(row, dataPathOf);
      if (symbol === undefined) return refuse('what was asked about', 'It is not a symbol.');
      return referencedBy(symbol);
    }
    const formKey = focusedRecord();
    const symbol: SymbolName | undefined = formKey === undefined ? await pick() : { kind: 'record', formKey };
    if (symbol !== undefined) await referencedBy(symbol);
  });
}
