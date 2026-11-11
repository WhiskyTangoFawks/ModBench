import type { MEditClient } from '../client';
import { referencesView } from '../drivingLib/referencesView';
import type { Reporter } from '../ports/reporter';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { openPluginSourceDocument } from '../textDocuments/pluginSource';
import { membersNaming } from './memberReferences';
import { referencedByInput, reportedForGesture, type ListedLocations } from './symbolPlaces';

export type FileClient = Pick<MEditClient, 'getFileReferences'> & RecordDocumentClient;

interface FileLanguageDeps {
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: FileClient;
}

/** A file as a symbol, named by its path in the Data folder: the records that name it, which mEdit answers (symbols.md,
 *  The symbols). */
export function fileLanguage({ reporter, client }: FileLanguageDeps) {
  const listed = async (path: string): Promise<ListedLocations> => {
    const { found, unread } = reportedForGesture(reporter, path, await membersNaming(client, openPluginSourceDocument, await client.getFileReferences(path)));
    return { locations: found, unread: unread.length };
  };

  return {
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
