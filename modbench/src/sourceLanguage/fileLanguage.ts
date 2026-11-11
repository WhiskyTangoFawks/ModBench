import type { MEditClient } from '../client';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import { errorMessage } from '../ports/errorMessage';
import { heldText } from '../textDocuments/heldText';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { referencesView } from '../drivingLib/referencesView';
import type { Reporter } from '../ports/reporter';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { openPluginSourceDocument } from '../textDocuments/pluginSource';
import { fieldPathOf, fieldAt, formKeyAt } from './sourceText';
import { recordTypeOfPathField } from './fieldMetadata';
import { membersNaming } from './memberReferences';
import { referencedByInput, reportedForGesture, type AskedIn, type ListedLocations } from './symbolPlaces';

export type FileClient = Pick<MEditClient, 'getFileReferences' | 'getComparison' | 'resolveFilePath'> & RecordDocumentClient;

/** What the box that owns the instance's files says of one: which copy the game gets, and showing it in the Explorer. */
export interface FileCopies {
  gameRelease: () => Promise<string>;
  /** The copy of the file at its path in the Data folder that the game gets. */
  copyOf: (path: string) => CopyAt | undefined;
  reveal: (copy: CopyAt) => Promise<void>;
}

interface FileLanguageDeps extends FileCopies {
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: FileClient;
}

/** A file as a symbol, named by its path in the Data folder: the records that name it, which mEdit answers (symbols.md,
 *  The symbols). */
export function fileLanguage({ reporter, client, gameRelease, copyOf, reveal }: FileLanguageDeps) {
  const listed = async (path: string): Promise<ListedLocations> => {
    const { found, unread } = reportedForGesture(reporter, path, await membersNaming(client, openPluginSourceDocument, await client.getFileReferences(path)));
    return { locations: found, unread: unread.length };
  };

  const pathAt = async (document: AskedIn, offset: number): Promise<{ start: number; end: number; given: string; field: string; recordType: string; release: string } | undefined> => {
    if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
    const text = heldText(document);
    const found = fieldAt(text, offset);
    if (found === undefined || formKeyAt(text, offset) !== undefined) return undefined;
    try {
      const recordType = await recordTypeOfPathField(client, found);
      return recordType === undefined ? undefined : {
        start: found.start + 1, end: found.end - 1, given: JSON.parse(text.slice(found.start, found.end)) as string, field: fieldPathOf(found.path), recordType, release: await gameRelease(),
      };
    } catch (error) {
      reporter.shownOnSurface('error', `Cannot tell whether ${found.recordFormKey} names a file here.`, errorMessage(error));
      return undefined;
    }
  };

  return {
    /** Go to Definition on the path at `offset`: the copy of its file the game gets, shown in the Explorer. Undefined where no
     *  path is; `resolved` is false where no copy exists. */
    definitionAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; resolved: boolean } | undefined> => {
      const found = await pathAt(document, offset);
      if (found === undefined) return undefined;
      const { start, end } = found;
      const file = await client.resolveFilePath(found.release, found.recordType, found.field, found.given);
      if (isReadFailed(file)) {
        reporter.shownOnSurface('warning', `Go to Definition cannot go to ${found.given}.`, failureReason(file));
        return { start, end, resolved: false };
      }
      const copy = copyOf(file);
      if (copy === undefined) {
        reporter.shownOnSurface('warning', `Go to Definition cannot go to ${file}.`, `No enabled mod, Overwrite or the Data folder holds ${file}.`);
        return { start, end, resolved: false };
      }
      await reveal(copy);
      return { start, end, resolved: true };
    },
    /** Lists each record that names the file at `path` in the Data folder, in VS Code's References view, anchored at the
     *  first. */
    referencedBy: async (path: string): Promise<void> => {
      const view = await referencesView();
      if (!view) return;
      const first = await listed(path);
      const [anchor] = first.locations;
      if (anchor === undefined) {
        reporter.report('error', `Could not list where files name ${path}.`, first.unread > 0 ? 'No record that could be read names it.' : 'No record names it.');
        return;
      }
      view.setInput(referencedByInput(`Referenced By: ${path}`, 'modbench.fileReferencedBy', anchor, () => listed(path), first));
    },
  };
}
