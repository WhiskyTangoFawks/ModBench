import * as vscode from 'vscode';

/** CONTEXT.md, Sort direction: whether the view lists winning at the top or at the bottom. */
export type SortDirection = 'losingAtTop' | 'winningAtTop';

/** The title-bar toggle for a view whose direction writes no file. The view starts losing at the
 *  top on each activation, and the context key, which outlives an extension host restart, is told
 *  so. */
export function registerSortDirectionToggle(
  object: string, view: { setViewDirection(direction: SortDirection): void },
): vscode.Disposable[] {
  const show = (direction: SortDirection) => {
    view.setViewDirection(direction);
    void vscode.commands.executeCommand('setContext', `modbench.${object}.winningAtTop`, direction === 'winningAtTop');
  };
  void vscode.commands.executeCommand('setContext', `modbench.${object}.winningAtTop`, false);
  return [
    vscode.commands.registerCommand(`modbench.${object}.sortWinningAtTop`, () => show('winningAtTop')),
    vscode.commands.registerCommand(`modbench.${object}.sortLosingAtTop`, () => show('losingAtTop')),
  ];
}
