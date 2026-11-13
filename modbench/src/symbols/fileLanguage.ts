import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../instanceLoader/instance';
import { errorMessage } from '../ports/errorMessage';
import { heldText } from '../textDocuments/heldText';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import { failureReason, isReadFailed } from '../wire/readFailed';
import type { Reporter } from '../ports/reporter';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { openPluginSourceDocument } from '../textDocuments/pluginSource';
import { fieldAt } from '../drivingLib/sourceText';
import { fieldPathOf, formKeyAt } from './formKeyText';
import { recordTypeOfPathField } from '../drivingLib/fieldMetadata';
import { membersNaming } from './memberReferences';
import { showReferencedBy, type AskedIn } from './symbolPlaces';
import type { Definition, Listed, Named, References, SymbolKind } from './symbolKind';

export type FileClient = Pick<MEditClient, 'getFileReferences' | 'getComparison' | 'resolveFilePath'> & RecordDocumentClient;

/** What the box that owns the instance's files says of one: which copy the game gets, and where it is shown. */
export interface FileCopies {
  gameRelease: () => Promise<string>;
  /** The copy of the file at its path in the Data folder that the game gets. */
  copyOf: (path: string) => CopyAt | { none: string };
  reveal: (copy: CopyAt) => Promise<void>;
}

interface FileLanguageDeps extends FileCopies {
  instance: { readonly value: Pick<InstanceValue, 'stackedCopies' | 'dataFolderFiles' | 'gameFolderArchived'> } | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: FileClient;
}

type FileNamed = { readonly kind: 'file'; readonly path: string };

const holdsCopy = (found: CopyAt | { none: string }): found is CopyAt => !('none' in found);

/** A file as a symbol, named by its path in the Data folder: the records that name it, which mEdit answers (symbols.md,
 *  The symbols). */
export function fileLanguage({ instance, reporter, client, gameRelease, copyOf, reveal }: FileLanguageDeps) {
  const pathAt = async (document: AskedIn, offset: number): Promise<Named<FileNamed> | undefined> => {
    if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
    const text = heldText(document);
    const found = fieldAt(text, offset);
    if (found === undefined || formKeyAt(text, offset) !== undefined) return undefined;
    try {
      const recordType = await recordTypeOfPathField(client, found);
      const given: unknown = JSON.parse(text.slice(found.start, found.end));
      if (recordType === undefined || typeof given !== 'string') return undefined;
      const path = await client.resolveFilePath(await gameRelease(), recordType, JSON.stringify(found.record), fieldPathOf(found.path));
      return { start: found.start + 1, end: found.end - 1, spelled: given, symbol: isReadFailed(path) ? { refused: failureReason(path) } : { kind: 'file', path } };
    } catch (error) {
      reporter.shownOnSurface('error', `Cannot tell whether ${found.recordFormKey} names a file here.`, errorMessage(error));
      return undefined;
    }
  };

  const referencesTo = async ({ path }: FileNamed): Promise<References> => {
    const { found, unread } = await membersNaming(client, openPluginSourceDocument, await client.getFileReferences(path));
    return { locations: found, unread };
  };

  const dataPaths = (): Map<string, string> => {
    const value = instance?.value;
    if (value === undefined) return new Map();
    const paths = [
      ...[...value.stackedCopies].map(({ relativePath }) => relativePath),
      ...value.dataFolderFiles.kind === 'listed' ? [...value.dataFolderFiles.files.values()].map(({ relativePath }) => relativePath) : [],
      ...[...value.gameFolderArchived.copies.values()].map(({ file }) => file),
    ];
    return new Map(paths.map((path) => [path.toLowerCase(), path]));
  };

  const kind: SymbolKind<FileNamed> = {
    nameAt: pathAt,
    /** The copy the game gets, inside its archive when archived. */
    definitionOf({ path }): Promise<Definition> {
      const copy = copyOf(path);
      return Promise.resolve(holdsCopy(copy) ? { shown: copy } : { refused: copy.none });
    },
    referencesTo,
    /** Its path in the Data folder. */
    hoverOf: ({ symbol, spelled }) => Promise.resolve(['refused' in symbol ? spelled : symbol.path]),
    completionsAt: () => Promise.resolve(undefined),
    /** Each file whose path in the Data folder holds `query`, at the copy the game gets. */
    symbolsFor(query) {
      const wanted = query.trim().toLowerCase();
      if (wanted === '') return Promise.resolve([]);
      return Promise.resolve([...dataPaths()].flatMap(([folded, path]): Listed[] => {
        if (!folded.includes(wanted)) return [];
        const copy = copyOf(path);
        if (!holdsCopy(copy)) return [];
        return [{
          name: path, detail: 'file', icon: vscode.SymbolKind.File, location: new vscode.Location(vscode.Uri.file(copy.kind === 'loose' ? copy.path : copy.archive), new vscode.Position(0, 0)),
          resolve: async () => { await reveal(copy); return undefined; },
        }];
      }));
    },
  };

  return {
    ...kind,
    /** Lists each record that names the file at `path` in the Data folder, in VS Code's References view. */
    referencedBy: (path: string): Promise<void> => showReferencedBy({
      reporter, subject: path, contextValue: 'modbench.fileReferencedBy', references: () => referencesTo({ kind: 'file', path }),
    }),
  };
}
