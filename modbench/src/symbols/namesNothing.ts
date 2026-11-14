import * as vscode from 'vscode';
import { modbenchDiagnostic } from '../drivingLib/modbenchDiagnostic';
import { coalesced } from '../ports/coalesced';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { inOrder, type NamesNothing, type SymbolKinds } from './symbolKind';

interface NamesNothingDeps {
  kinds: SymbolKinds;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  /** Told whenever what a name resolves to may have changed. */
  onInstanceChanged: (listener: () => void) => { dispose: () => unknown };
}

/** Every name the document holds that names nothing, whatever its kind, in text order. */
async function namesNothingIn(kinds: SymbolKinds, document: Pick<vscode.TextDocument, 'getText'> & { readonly uri: Pick<vscode.Uri, 'fsPath'> }): Promise<NamesNothing[]> {
  const found = await Promise.all(inOrder(kinds).map((kind) => kind.namesNothingIn?.(document) ?? Promise.resolve([])));
  return found.flat().sort((a, b) => a.start - b.start);
}

/** A reference that names nothing is a problem on its place in the document, for each open document (symbols.md, The
 *  features, story 8). */
export function registerNamesNothing({ kinds, reporter, onInstanceChanged }: NamesNothingDeps): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('modbench-names');
  const failed = new Set<string>();
  const judge = async (document: vscode.TextDocument) => {
    if (document.uri.scheme !== 'file') return;
    try {
      const found = await namesNothingIn(kinds, document);
      failed.delete(document.uri.fsPath);
      collection.set(document.uri, found.map(({ start, end, name, why }) =>
        modbenchDiagnostic(new vscode.Range(document.positionAt(start), document.positionAt(end)), `${name} names nothing. ${why}`, vscode.DiagnosticSeverity.Warning)));
    } catch (error) {
      if (!failed.has(document.uri.fsPath)) reporter.shownOnSurface('warning', 'The Problems panel shows the last names that name nothing.', errorMessage(error));
      failed.add(document.uri.fsPath);
    }
  };
  const judgeAll = coalesced(() => Promise.all(vscode.workspace.textDocuments.map(judge)));
  judgeAll();
  return vscode.Disposable.from(
    collection,
    onInstanceChanged(judgeAll),
    vscode.workspace.onDidOpenTextDocument((document) => { void judge(document); }),
    vscode.workspace.onDidChangeTextDocument(({ document }) => { void judge(document); }),
    vscode.workspace.onDidCloseTextDocument((document) => { collection.delete(document.uri); failed.delete(document.uri.fsPath); }),
  );
}
