import * as vscode from 'vscode';
import type { ReferencesViewInput } from '../drivingLib/referencesView';
import { sameName, type HeldTexts, type PlaceInFile } from '../symbolNames/symbolNames';
import { locationsList } from './locationsList';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';

interface Reading<Reference> {
  readonly references: readonly Reference[];
  readonly leftOut: readonly string[];
}

/** An owner's reading of the symbol, or why it could not read at all. */
export const readBy = <Symbol, Reference>(
  owner: { read(symbol: Symbol, held: HeldTexts): Promise<Reading<Reference>> }, symbol: Symbol, held: HeldTexts,
): Promise<Reading<Reference>> =>
  owner.read(symbol, held).catch((error: unknown) => ({ references: [], leftOut: [errorMessage(error)] }));

/** The line above a list of places: an empty list says so, and that it is no proof while a file went unread. */
export function listMessage(found: number, unread: number): string | undefined {
  if (found > 0) return undefined;
  return unread > 0 ? 'No references found in the files that could be read.' : 'No references found.';
}

type Unread = Pick<Reporter, 'report' | 'shownOnSurface'>;

/** `references` of `subject`, with a notification naming each file the gesture could not read. */
export function reportedForGesture<References extends { readonly unread: readonly string[] }>(reporter: Unread, subject: string, references: References): References {
  if (references.unread.length > 0) {
    reporter.report('warning', `Referenced by on ${subject} could not read every file that may name it.`, references.unread.join('\n'));
  }
  return references;
}

/** `references` of `subject`, with a line in the Output for each file the feature could not read. */
export function reportedForFeature<References extends { readonly unread: readonly string[] }>(reporter: Unread, subject: string, references: References): References {
  for (const why of references.unread) {
    reporter.shownOnSurface('warning', `Find All References on ${subject} could not read a file that may name it.`, why);
  }
  return references;
}

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
