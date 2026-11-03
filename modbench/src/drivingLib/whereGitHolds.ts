import * as vscode from 'vscode';
import type { SourceModIn } from '../wire/pluginAddress';

const OPTIONS = [
  { label: 'A source mod in a new repository', where: 'NewRepository' },
  { label: 'A source mod in the modlist repository', where: 'ModlistRepository' },
  { label: 'The mod\'s whole folder in the modlist repository', where: 'WholeFolder' },
] as const;

// commands.md, No dead entries: the modlist repository is a choice only while the instance holds one, and a pick of one
// choice is not shown.
export function pickWhereGitHolds(holdsRepository: boolean, gesture: string): Promise<SourceModIn | undefined>;
export function pickWhereGitHolds(holdsRepository: boolean, gesture: string, offersWholeFolder: true): Promise<SourceModIn | 'WholeFolder' | undefined>;
export async function pickWhereGitHolds(holdsRepository: boolean, gesture: string, offersWholeFolder = false): Promise<SourceModIn | 'WholeFolder' | undefined> {
  if (!holdsRepository) return 'NewRepository';
  const picked = await vscode.window.showQuickPick(
    OPTIONS.filter(({ where }) => offersWholeFolder || where !== 'WholeFolder'), { placeHolder: `${gesture}: where git holds the mod` },
  );
  return picked?.where;
}
