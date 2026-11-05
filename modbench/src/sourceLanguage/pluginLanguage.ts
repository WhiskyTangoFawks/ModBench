import * as vscode from 'vscode';
import { referencesView, type ReferencesViewInput } from '../drivingLib/referencesView';
import type { Instance } from '../instanceLoader/instance';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { heldTexts, pluginNamed, type PlaceInFile, type PluginName, type PluginSymbol, type SymbolOwner } from '../symbolNames/symbolNames';
import { heldText, unsavedTexts } from '../textDocuments/heldText';
import { openPluginSourceDocument } from '../textDocuments/pluginSource';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { headerFormKeyOf } from '../wire/headerFormKey';
import { pluginRowName } from '../wire/pluginAddress';
import { locationsList } from './locationsList';
import { listMessage, pluginReferencesOf, type PluginReference } from './pluginReferences';
import { locateRecord, locationOf } from './recordLocation';
import { formKeyPluginAt, formKeyValue } from './sourceText';

interface PluginLanguageDeps {
  instance: Pick<Instance, 'value'> | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: RecordDocumentClient;
  owners: readonly SymbolOwner[];
}

interface ListedLocations {
  readonly locations: vscode.Location[];
  readonly unread: number;
}

const placeLocation = ({ file, start, end }: PlaceInFile): vscode.Location =>
  new vscode.Location(vscode.Uri.file(file), new vscode.Range(start.line, start.character, end.line, end.character));

const locationOfReference = (found: PluginReference<vscode.TextDocument>): vscode.Location =>
  ('file' in found ? placeLocation(found) : locationOf(found));

function referencedByInput(title: string, location: vscode.Location, read: () => Promise<ListedLocations>, first?: ListedLocations): ReferencesViewInput {
  let unshown = first;
  return {
    title, location, contextValue: 'modbench.pluginReferencedBy',
    resolve: async () => {
      const { locations, unread } = unshown ?? await read();
      unshown = undefined;
      return locationsList(locations, listMessage(locations.length, unread));
    },
    with: (moved) => referencedByInput(title, moved, read),
  };
}

/** A plugin as a symbol in the text editor: inside a FormKey, and wherever an owner's file names it (source.md, In the
 *  text editor), and the places files name it. */
export function pluginLanguage({ instance, reporter, client, owners }: PluginLanguageDeps) {
  const referencesTo = pluginReferencesOf({
    owners, reporter, client, open: openPluginSourceDocument,
    plugins: () => instance?.value.plugins ?? [],
    held: () => heldTexts(unsavedTexts()),
  });
  const listed = async (plugin: PluginSymbol): Promise<ListedLocations> => {
    const { found, unread } = await referencesTo(plugin);
    return { locations: found.map(locationOfReference), unread: unread.length };
  };

  const nameAt = async (document: vscode.TextDocument, offset: number): Promise<PluginName | undefined> => {
    const text = heldText(document);
    if (isPluginSourcePath(document.uri.fsPath)) return formKeyPluginAt(text, offset);
    for (const owner of owners) {
      const named = await owner.nameAt(document.uri.fsPath, text, offset);
      if (named !== undefined) return named;
    }
    return undefined;
  };

  // Referenced By anchors at the plugin's header, as a record's anchors at its FormKey; else at a place that names it.
  const anchorOf = async (plugin: PluginSymbol, first: ListedLocations): Promise<vscode.Location | { refused: string }> => {
    const header = await locateRecord({ client, open: openPluginSourceDocument }, { formKey: headerFormKeyOf(plugin), plugin }, formKeyValue)
      .catch((error: unknown) => ({ refused: errorMessage(error) }));
    if (header && !('refused' in header)) return locationOf(header);
    return first.locations[0] ?? { refused: header?.refused ?? `No active plugin holds ${headerFormKeyOf(plugin)}.` };
  };

  return {
    /** Find All References on the plugin whose name is at `offset`; undefined where no plugin's name is. */
    referencesAt: async (document: vscode.TextDocument, offset: number): Promise<vscode.Location[] | undefined> => {
      const named = await nameAt(document, offset);
      if (named === undefined) return undefined;
      const plugin = pluginNamed(named, instance?.value.plugins ?? []);
      if (plugin) return (await listed(plugin)).locations;
      reporter.shownOnSurface('warning', `Find All References cannot list what names ${named.name}.`, `Mod order resolves ${named.name} to no plugin.`);
      return [];
    },
    /** Lists each place a file names `plugin`, in VS Code's References view. */
    referencedBy: async (plugin: PluginSymbol): Promise<void> => {
      const view = await referencesView();
      if (!view) return;
      const first = await listed(plugin);
      const anchor = await anchorOf(plugin, first);
      if ('refused' in anchor) {
        reporter.report('error', `Could not list where files name ${pluginRowName(plugin)}.`, anchor.refused);
        return;
      }
      view.setInput(referencedByInput(`Referenced By: ${pluginRowName(plugin)}`, anchor, () => listed(plugin), first));
    },
  };
}
