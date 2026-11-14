import type * as vscode from 'vscode';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import type { Definition } from './symbolKind';
import { atFile } from './symbolPlaces';

export type Shown = Exclude<Definition, { readonly none: string } | { readonly refused: string }>;

/** Shows a definition: selects its row, or shows its copy in the Explorer; else the place a caller opens. */
export async function showDefinition(definition: Shown, reveal: (copy: CopyAt) => Promise<void>): Promise<vscode.Location | undefined> {
  if ('at' in definition) return definition.at;
  if ('file' in definition) return atFile(definition.file);
  if ('row' in definition) await definition.show();
  else await reveal(definition.shown);
  return undefined;
}

/** Go to Symbol in Workspace's resolve for a symbol whose definition may be a row: selects it, leaving the symbol where
 *  it is listed. */
export const selectingItsRow = (definition: () => Promise<Definition>) => async (): Promise<undefined> => {
  const found = await definition();
  if ('row' in found) await found.show();
  return undefined;
};
