import * as vscode from 'vscode';
import { listedSymbols, type Listed, type SymbolKinds, type SymbolName } from './symbolKind';

interface SymbolItem extends vscode.QuickPickItem { readonly symbol: SymbolName }

const itemOf = ({ symbol, name, detail }: Listed): SymbolItem => ({ symbol, label: name, description: detail });

/** Asks for a symbol as Go to Symbol in Workspace finds it: the symbols whose name holds what is typed. */
export function pickSymbol(kinds: SymbolKinds): Promise<SymbolName | undefined> {
  const pick = vscode.window.createQuickPick<SymbolItem>();
  pick.placeholder = 'Type the name of a symbol';
  let typed = 0;
  return new Promise((resolve) => {
    pick.onDidChangeValue(async (value) => {
      const mine = ++typed;
      pick.busy = true;
      const listed = await listedSymbols(kinds, value);
      if (mine !== typed) return;
      pick.items = listed.map(itemOf);
      pick.busy = false;
    });
    pick.onDidAccept(() => { resolve(pick.selectedItems[0]?.symbol); pick.hide(); });
    pick.onDidHide(() => { resolve(undefined); pick.dispose(); });
    pick.show();
  });
}
