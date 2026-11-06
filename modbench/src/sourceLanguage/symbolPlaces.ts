import * as vscode from 'vscode';
import type { ReferencesViewInput } from '../drivingLib/referencesView';
import { sameName, type PlaceInFile } from '../symbolNames/symbolNames';
import { locationsList } from './locationsList';
import { listMessage } from './pluginReferences';

/** The span of `name` around `offset`, as the text spells it; an owner's name may sit anywhere in its file's text. */
export function spelledAround(text: string, offset: number, name: string): { start: number; end: number; name: string } | undefined {
  for (let start = Math.max(0, offset - name.length); start <= offset; start += 1) {
    const spelled = text.slice(start, start + name.length);
    if (sameName(spelled, name)) return { start, end: start + name.length, name: spelled };
  }
  return undefined;
}

export type AskedIn = Pick<vscode.TextDocument, 'getText'> & { readonly uri: Pick<vscode.Uri, 'fsPath'> };

export interface ListedLocations {
  readonly locations: vscode.Location[];
  readonly unread: number;
}

export const placeLocation = ({ file, start, end }: PlaceInFile): vscode.Location =>
  new vscode.Location(vscode.Uri.file(file), new vscode.Range(start.line, start.character, end.line, end.character));

/** What the References view shows for Referenced By: the places `read` lists, anchored at `location`, which `first` has already read. */
export function referencedByInput(
  title: string, contextValue: string, location: vscode.Location, read: () => Promise<ListedLocations>, first?: ListedLocations,
): ReferencesViewInput {
  let unshown = first;
  return {
    title, location, contextValue,
    resolve: async () => {
      const { locations, unread } = unshown ?? await read();
      unshown = undefined;
      return locationsList(locations, listMessage(locations.length, unread));
    },
    with: (moved) => referencedByInput(title, contextValue, moved, read),
  };
}
