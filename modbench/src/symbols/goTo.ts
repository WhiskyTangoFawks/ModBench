import * as vscode from 'vscode';
import { downloadedFileArgumentOf, modArgumentOf, pluginArgumentOf, separatorArgumentOf } from '../drivingLib/argument';
import { recordArgumentOf } from '../drivingLib/recordArgument';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import type { Reporter } from '../ports/reporter';
import { showDefinition } from './definitionShown';
import type { SymbolKinds, SymbolName } from './symbolKind';
import { asked } from './symbolKind';

interface GoToDeps {
  kinds: SymbolKinds;
  reporter: Pick<Reporter, 'report'>;
  reveal: (copy: CopyAt) => Promise<void>;
  selection: () => readonly unknown[];
  dataPathOf: (row: unknown) => string | undefined;
}

function symbolOf(row: unknown, dataPathOf: GoToDeps['dataPathOf']): SymbolName | undefined {
  const plugin = pluginArgumentOf(row)?.plugin;
  const downloaded = downloadedFileArgumentOf(row)?.row.name;
  const path = dataPathOf(row);
  if (plugin !== undefined) return { kind: 'plugin', ...plugin };
  if (downloaded !== undefined) return { kind: 'downloadedFile', name: downloaded };
  if (path !== undefined) return { kind: 'file', path };
  return modArgumentOf(row) ?? separatorArgumentOf(row);
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
    if (recordArgumentOf(row) !== undefined) {
      reporter.report('error', 'Could not go to a record: go to takes no record, and open shows it.');
      return;
    }
    const symbol = symbolOf(row, dataPathOf);
    if (symbol === undefined) {
      await vscode.commands.executeCommand('workbench.action.showAllSymbols');
      return;
    }
    const definition = await asked(kinds, symbol).definition();
    if ('refused' in definition || 'none' in definition) {
      reporter.report('error', `Could not go to ${nameOf(symbol)}: ${'refused' in definition ? definition.refused : definition.none}`);
      return;
    }
    const location = await showDefinition(definition, reveal);
    if (location !== undefined) await vscode.commands.executeCommand('vscode.open', location.uri, { selection: location.range });
  });
}
