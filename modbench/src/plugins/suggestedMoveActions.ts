import * as vscode from 'vscode';
import type { OfferedMove } from '../pluginCommands/pluginOrder';
import { chosenMoveOf } from './applySuggestedMoveCommand';

interface SuggestedMoveActionsDeps {
  userlistPath: () => string;
  moves: () => readonly OfferedMove[];
}

/** plugins.md, Sorting rules, story 5: apply suggested move as a code action on the line of the userlist that states the broken rule. */
export function suggestedMoveActions({ userlistPath, moves }: SuggestedMoveActionsDeps) {
  return {
    provideCodeActions(document: { readonly uri: { readonly fsPath: string } }, range: { readonly start: { readonly line: number }; readonly end: { readonly line: number } }): vscode.CodeAction[] {
      if (document.uri.fsPath !== userlistPath()) return [];
      return moves().filter(({ rule: { source } }) => source?.file === 'userlist' && source.line >= range.start.line && source.line <= range.end.line)
        .map((move) => {
          const action = new vscode.CodeAction(`Apply suggested move: ${move.rule.reason}`, vscode.CodeActionKind.QuickFix);
          action.command = { command: 'modbench.plugin.applySuggestedMove', title: 'Apply suggested move', arguments: [undefined, undefined, chosenMoveOf(move)] };
          return action;
        });
    },
  } satisfies vscode.CodeActionProvider;
}
