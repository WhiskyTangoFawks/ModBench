import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { SourceNames } from './sourceNames';
import { foldPath, type CopyAt } from '../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../instanceLoader/instance';
import { heldText } from '../textDocuments/heldText';
import type { Reporter } from '../ports/reporter';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { openPluginSourceDocument } from '../textDocuments/pluginSource';
import { membersNaming } from './memberReferences';
import { listedAtCopy, showReferencedBy, tooltipLines, type AskedIn } from './symbolPlaces';
import type { Definition, FileNamed, Listed, Named, References, SymbolKind } from './symbolKind';

export type FileClient = Pick<MEditClient, 'getFileReferences'> & RecordDocumentClient;

/** What the box that owns the instance's files says of one: which copy the game gets, and where it is shown. */
export interface FileCopies {
  /** The copy of the file at its path in the Data folder that the game gets. */
  copyOf: (path: string) => CopyAt | { none: string };
  reveal: (copy: CopyAt) => Promise<void>;
}

interface FileLanguageDeps extends FileCopies {
  instance: { readonly value: FilesValue } | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: FileClient;
  names: Pick<SourceNames, 'fileAt' | 'pathTypedAt' | 'membersIn' | 'formKeyIn'>;
  /** The tooltip of the row Mods shows for the copy the game gets of the file at `path`; undefined where it shows none. */
  tooltip: (path: string) => string | undefined;
}

export const holdsCopy = (found: CopyAt | { none: string }): found is CopyAt => !('none' in found);

type FilesValue = Pick<InstanceValue, 'stackedCopies' | 'dataFolderFiles' | 'gameFolderArchived'>;
type FoldedPath = readonly [folded: string, path: string];

// A modlist holds hundreds of thousands of files, and VS Code asks again at each keystroke: an instance value's paths
// are folded once, and a query lists no more than a person reads down, since typing more narrows it.
const MOST_FILES_LISTED = 1000;
const folded = new WeakMap<FilesValue, readonly FoldedPath[]>();

function foldedPathsOf(value: FilesValue): readonly FoldedPath[] {
  const known = folded.get(value);
  if (known !== undefined) return known;
  const paths = [
    ...[...value.stackedCopies].map(({ relativePath }) => relativePath),
    ...value.dataFolderFiles.kind === 'listed' ? [...value.dataFolderFiles.files.values()].map(({ relativePath }) => relativePath) : [],
    ...[...value.gameFolderArchived.copies.values()].map(({ file }) => file),
  ];
  const each = [...new Map(paths.map((path): FoldedPath => [foldPath(path), path]))];
  folded.set(value, each);
  return each;
}

// Plugin source holds a path's backslashes escaped.
const foldedPathOf = (held: string): string => foldPath(held.replaceAll('\\\\', '\\'));

/** A file as a symbol, named by its path in the Data folder: the records that name it, which mEdit answers (symbols.md,
 *  The symbols). */
export function fileLanguage({ instance, reporter, client, names, copyOf, reveal, tooltip }: FileLanguageDeps): SymbolKind<FileNamed> {
  const pathAt = async (document: AskedIn, offset: number, token?: vscode.CancellationToken): Promise<Named<FileNamed> | undefined> => {
    const found = await names.fileAt(document.uri.fsPath, heldText(document), offset, token);
    if (found === undefined) return undefined;
    const span = { start: found.start, end: found.end };
    return 'refused' in found ? { ...span, name: found.given, symbol: { refused: found.refused } } : { ...span, name: found.path, symbol: { kind: 'file', path: found.path } };
  };

  const referencesTo = async ({ path }: FileNamed, token?: vscode.CancellationToken): Promise<References> => {
    const { found, unread } = await membersNaming(client, openPluginSourceDocument, names, await client.getFileReferences(path, token));
    return { locations: found, unread };
  };

  const dataPaths = (): readonly FoldedPath[] => (instance === undefined ? [] : foldedPathsOf(instance.value));

  const listedAt = (path: string, copy: CopyAt): Listed => ({
    symbol: { kind: 'file', path }, name: path, detail: 'file', icon: vscode.SymbolKind.File, ...listedAtCopy(copy, reveal),
  });

  const kind: SymbolKind<FileNamed> = {
    nameAt: pathAt,
    referencedBy: (named) => showReferencedBy({
      reporter, subject: named.path, contextValue: 'modbench.fileReferencedBy', references: () => referencesTo(named),
    }),
    /** The copy the game gets, inside its archive when archived. */
    definitionOf({ path }): Promise<Definition> {
      const copy = copyOf(path);
      return Promise.resolve(holdsCopy(copy) ? { shown: copy } : { refused: copy.none });
    },
    referencesTo,
    tooltipOf: ({ path }) => Promise.resolve(tooltipLines(tooltip(path))),
    /** Each file of the path's asset type whose path holds the text typed so far, spelled with its folder where the
     *  text starts with it, up to `MOST_FILES_LISTED`; the Output says how many more match. */
    async completionsAt(document, offset, { gesture }) {
      const found = await names.pathTypedAt(document.uri.fsPath, heldText(document), offset);
      if (found === undefined) return undefined;
      const typed = foldedPathOf(found.typed);
      const folder = `${found.assetType.folder.toLowerCase()}/`;
      const spelledFrom = typed.startsWith(folder) ? 0 : folder.length;
      const extensions = found.assetType.extensions.map((extension) => extension.toLowerCase());
      const offered = dataPaths().filter(([path]) =>
        path.startsWith(folder) && extensions.some((extension) => path.endsWith(extension)) && path.slice(spelledFrom).includes(typed));
      const items = offered.slice(0, MOST_FILES_LISTED).map(([, path]) => {
        const held = path.slice(spelledFrom).replaceAll('/', '\\');
        return { label: held, insertText: JSON.stringify(held).slice(1, -1) };
      });
      const isIncomplete = items.length < offered.length;
      if (isIncomplete) {
        const matching = typed === '' ? '' : ` whose path holds "${typed}"`;
        reporter.shownOnSurface('warning', `${gesture} lists ${items.length} of the ${offered.length} files in ${found.assetType.folder}${matching}.`,
          `It lists at most ${MOST_FILES_LISTED}. Type more of the path to narrow the list.`);
      }
      return { start: found.start, end: found.end, icon: vscode.CompletionItemKind.File, items, isIncomplete };
    },
    /** Each file whose path in the Data folder holds `query`, at the copy the game gets, up to `MOST_FILES_LISTED`; the
     *  Output says how many more match. */
    symbolsFor(query, { gesture }) {
      const wanted = foldPath(query);
      const matching = dataPaths().filter(([path]) => path.includes(wanted));
      const listed: Listed[] = [];
      for (const [, path] of matching) {
        if (listed.length === MOST_FILES_LISTED) break;
        const copy = copyOf(path);
        if (holdsCopy(copy)) listed.push(listedAt(path, copy));
      }
      if (listed.length < matching.length) {
        reporter.shownOnSurface(
          'warning', `${gesture} lists ${listed.length} of the ${matching.length} files whose path holds "${query}".`,
          `It lists at most ${MOST_FILES_LISTED}, and none whose copy the game gets is outside the workspace. Type more of the path to narrow the list.`,
        );
      }
      return Promise.resolve(listed);
    },
  };

  return kind;
}
