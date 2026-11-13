import * as vscode from 'vscode';
import { referencesView, type ReferencesViewInput } from '../drivingLib/referencesView';
import { sameName, type CopyNaming, type HeldTexts, type PlaceInFile } from '../symbolNames/symbolNames';
import { copyOf, RENDERED_DOCUMENT_SCHEME } from '../textDocuments/recordDocument';
import { locationsList } from './locationsList';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import type { References } from './symbolKind';

interface Reading<Reference> {
  readonly references: readonly Reference[];
  readonly leftOut: readonly string[];
}

/** An owner's reading of the symbol, or why it could not read at all. */
export const readBy = <Symbol, Reference>(
  owner: { read(symbol: Symbol, held: HeldTexts): Promise<Reading<Reference>> }, symbol: Symbol, held: HeldTexts,
): Promise<Reading<Reference>> =>
  owner.read(symbol, held).catch((error: unknown) => ({ references: [], leftOut: [errorMessage(error)] }));

function listMessage(found: number, unread: number): string | undefined {
  if (found > 0) return undefined;
  return unread > 0 ? 'No references found in the files that could be read.' : 'No references found.';
}

type Unread = Pick<Reporter, 'report' | 'shownOnSurface'>;

function reportedForGesture<References extends { readonly unread: readonly string[] }>(reporter: Unread, subject: string, references: References): References {
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

/** A rendered plugin is no file, so its reference sits at the record that holds it (symbols.md, The features, story 10). */
export const referenceOf = (location: vscode.Location): PlaceInFile | CopyNaming =>
  (location.uri.scheme === RENDERED_DOCUMENT_SCHEME ? copyOf(location.uri) : placeOfLocation(location));

export const placeOfLocation = ({ uri, range }: vscode.Location): PlaceInFile =>
  ({ file: uri.fsPath, start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } });

function referencedByInput(
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

interface ReferencedBy {
  readonly reporter: Unread;
  readonly subject: string;
  readonly contextValue: string;
  readonly references: () => Promise<References>;
  /** Where the list anchors, given its first read; its first place when absent. */
  readonly anchorOf?: (first: ListedLocations) => Promise<vscode.Location | { refused: string }>;
}

const firstPlace = ({ locations: [first], unread }: ListedLocations): Promise<vscode.Location | { refused: string }> =>
  Promise.resolve(first ?? { refused: unread > 0 ? 'No file that could be read names it.' : 'No file names it.' });

/** `referenced by`: the places `references` lists, in VS Code's References view (commands.md, Symbol). */
export async function showReferencedBy({ reporter, subject, contextValue, references, anchorOf = firstPlace }: ReferencedBy): Promise<void> {
  const view = await referencesView();
  if (!view) return;
  const listed = async (): Promise<ListedLocations | { refused: string }> => {
    const found = await references();
    if ('refused' in found) return found;
    const { locations, unread } = reportedForGesture(reporter, subject, found);
    return { locations: [...locations], unread: unread.length };
  };
  const refused = (why: string): void => { reporter.report('error', `Could not list where files name ${subject}.`, why); };
  const first = await listed();
  if ('refused' in first) return refused(first.refused);
  const anchor = await anchorOf(first);
  if ('refused' in anchor) return refused(anchor.refused);
  const again = async (): Promise<ListedLocations> => {
    const found = await listed();
    if (!('refused' in found)) return found;
    refused(found.refused);
    return { locations: [], unread: 1 };
  };
  view.setInput(referencedByInput(`Referenced By: ${subject}`, contextValue, anchor, again, first));
}
