import * as vscode from 'vscode';
import type { SourceModIn } from '../wire/pluginAddress';

// commands.md, No dead entries: the modlist repository is a choice only while the instance holds one, and a pick of one
// choice is not shown.
export async function pickWhereGitHolds(holdsRepository: boolean, gesture: string): Promise<SourceModIn | undefined> {
  if (!holdsRepository) return 'NewRepository';
  const picked = await vscode.window.showQuickPick([
    { label: 'A source mod in a new repository', where: 'NewRepository' as const },
    { label: 'A source mod in the modlist repository', where: 'ModlistRepository' as const },
  ], { placeHolder: `${gesture}: where git holds the mod` });
  return picked?.where;
}
