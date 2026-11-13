import * as vscode from 'vscode';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import type { Definition } from './symbolKind';

export type Shown = Exclude<Definition, { readonly none: string } | { readonly refused: string }>;

/** Shows a definition: selects its row, or shows its copy in the Explorer; else the place a caller opens. */
export async function showDefinition(definition: Shown, reveal: (copy: CopyAt) => Promise<void>): Promise<vscode.Location | undefined> {
  if ('at' in definition) return definition.at;
  if ('file' in definition) return new vscode.Location(vscode.Uri.file(definition.file), new vscode.Position(0, 0));
  if ('row' in definition) await definition.show();
  else await reveal(definition.shown);
  return undefined;
}
