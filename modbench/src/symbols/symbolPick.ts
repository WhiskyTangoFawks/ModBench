import * as vscode from 'vscode';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { listedSymbols, type Listed, type SymbolKinds, type SymbolName } from './symbolKind';

interface SymbolItem extends vscode.QuickPickItem { readonly symbol: SymbolName }

const itemOf = ({ symbol, name, detail }: Listed): SymbolItem => ({ symbol, label: name, description: detail });

/** Asks, for `gesture`, for a symbol as Go to Symbol in Workspace finds it: the symbols whose name holds what is typed. */
export function pickSymbol(kinds: SymbolKinds, reporter: Pick<Reporter, 'report'>, gesture: string): Promise<SymbolName | undefined> {
  const pick = vscode.window.createQuickPick<SymbolItem>();
  pick.placeholder = 'Type the name of a symbol';
  let typed = 0;
  return new Promise((resolve) => {
    pick.onDidChangeValue(async (value) => {
      const mine = ++typed;
      pick.busy = true;
      try {
        const listed = await listedSymbols(kinds, value, { gesture, cancelled: () => mine !== typed });
        if (mine === typed) pick.items = listed.map(itemOf);
      } catch (error) {
        reporter.report('error', 'Could not list the symbols that hold what was typed.', errorMessage(error));
      }
      if (mine === typed) pick.busy = false;
    });
    pick.onDidAccept(() => { resolve(pick.selectedItems[0]?.symbol); pick.hide(); });
    pick.onDidHide(() => { typed++; resolve(undefined); pick.dispose(); });
    pick.show();
  });
}
