import * as vscode from 'vscode';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import type { Reporter } from '../ports/reporter';
import { showDefinition } from './definitionShown';
import { symbolOfRow } from './rowSymbol';
import type { SymbolKinds, SymbolName } from './symbolKind';
import { asked } from './symbolKind';

interface GoToDeps {
  kinds: SymbolKinds;
  reporter: Pick<Reporter, 'report'>;
  reveal: (copy: CopyAt) => Promise<void>;
  selection: () => readonly unknown[];
  dataPathOf: (row: unknown) => string | undefined;
}

const nameOf = (symbol: SymbolName): string => {
  if (symbol.kind === 'plugin') return `"${symbol.name}" (${symbol.origin})`;
  if (symbol.kind === 'record') return symbol.formKey;
  return `"${'path' in symbol ? symbol.path : symbol.name}"`;
};

/** `go to` (commands.md). With no row given and none selected, it asks for a symbol as Go to Symbol in Workspace finds
 *  it. */
export function registerGoTo({ kinds, reporter, reveal, selection, dataPathOf }: GoToDeps): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.symbol.goTo', async (clicked?: unknown) => {
    const [only, ...rest] = selection();
    const row = clicked ?? (rest.length === 0 ? only : undefined);
    const symbol = symbolOfRow(row, dataPathOf);
    if (symbol?.kind === 'record') {
      reporter.report('error', 'Could not go to a record: go to takes no record, and open shows it.');
      return;
    }
    if (symbol === undefined) {
      await vscode.commands.executeCommand('workbench.action.showAllSymbols');
      return;
    }
    const definition = await asked(kinds, symbol).definition();
    if ('refused' in definition || 'none' in definition) {
      reporter.report('error', `Could not go to ${nameOf(symbol)}: ${'refused' in definition ? definition.refused : definition.none}`);
      return;
    }
    await showDefinition(definition, reveal);
  });
}
