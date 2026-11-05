import * as vscode from 'vscode';
import { referencesView, type ReferencesViewInput } from '../drivingLib/referencesView';
import type { Instance } from '../instanceLoader/instance';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import { buildFilePluginAt } from '../manifestAdapter/manifestAdapter';
import type { Reporter } from '../ports/reporter';
import { pluginNamed, type PlaceInFile, type PluginName, type PluginSymbol, type SymbolOwner } from '../symbolNames/symbolNames';
import { heldText, unsavedTexts } from '../textDocuments/heldText';
import { openPluginSourceDocument } from '../textDocuments/pluginSource';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { pluginRowName } from '../wire/pluginAddress';
import { BUILD_FILE } from '../wire/sourceMod';
import { locationsList } from './locationsList';
import { pluginReferencesOf, type PluginReference } from './pluginReferences';
import { locationOf } from './recordLocation';
import { formKeyPluginAt } from './sourceText';

interface PluginLanguageDeps {
  instance: Pick<Instance, 'value'> | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'landed'>;
  client: RecordDocumentClient;
  owners: readonly SymbolOwner[];
}

const NO_SOURCE_DIRS: ReadonlyMap<string, string> = new Map();

const placeLocation = ({ file, start, end }: PlaceInFile): vscode.Location =>
  new vscode.Location(vscode.Uri.file(file), new vscode.Range(start.line, start.character, end.line, end.character));

const locationOfReference = (found: PluginReference<vscode.TextDocument>): vscode.Location =>
  ('file' in found ? placeLocation(found) : locationOf(found));

function referencedByInput(title: string, location: vscode.Location, read: () => Promise<vscode.Location[]>, first?: vscode.Location[]): ReferencesViewInput {
  let unshown = first;
  return {
    title, location, contextValue: 'modbench.pluginReferencedBy',
    resolve: async () => {
      const locations = unshown ?? await read();
      unshown = undefined;
      return locationsList(locations);
    },
    with: (moved) => referencedByInput(title, moved, read),
  };
}

/** A plugin as a symbol in the text editor: inside a FormKey, and in a build file's step, its name (source.md, In the
 *  text editor), and the places files name it. */
export function pluginLanguage({ instance, reporter, client, owners }: PluginLanguageDeps) {
  const plugins = () => instance?.value.plugins ?? [];
  const buildFileMod = (path: string): string | undefined =>
    [...instance?.value.paths.sourceDirs ?? NO_SOURCE_DIRS].find(([, folder]) => vscode.Uri.joinPath(vscode.Uri.file(folder), BUILD_FILE).fsPath === path)?.[0];
  const referencesTo = pluginReferencesOf({
    owners, plugins, reporter, client, open: openPluginSourceDocument,
    held: () => unsavedTexts((path) => isPluginSourcePath(path) || buildFileMod(path) !== undefined),
  });
  const locations = async (plugin: PluginSymbol) => (await referencesTo(plugin)).map(locationOfReference);

  const nameAt = (document: vscode.TextDocument, offset: number): PluginName | undefined => {
    const text = heldText(document);
    if (isPluginSourcePath(document.uri.fsPath)) return formKeyPluginAt(text, offset);
    const mod = buildFileMod(document.uri.fsPath);
    const named = mod === undefined ? undefined : buildFilePluginAt(text, offset);
    return named && mod !== undefined ? { name: named.name, origin: mod } : undefined;
  };

  return {
    /** Find All References on the plugin whose name is at `offset`; undefined where no plugin's name is. */
    referencesAt: async (document: vscode.TextDocument, offset: number): Promise<vscode.Location[] | undefined> => {
      const named = nameAt(document, offset);
      if (named === undefined) return undefined;
      const plugin = pluginNamed(named, plugins());
      if (plugin) return locations(plugin);
      reporter.shownOnSurface('warning', `Find All References cannot list what names ${named.name}.`, `Mod order resolves ${named.name} to no plugin.`);
      return [];
    },
    /** Lists each place a file names `plugin`, in VS Code's References view. */
    referencedBy: async (plugin: PluginSymbol): Promise<void> => {
      const view = await referencesView();
      if (!view) return;
      const first = await locations(plugin);
      const [anchor] = first;
      if (anchor === undefined) {
        reporter.landed(`No file names ${pluginRowName(plugin)}.`);
        return;
      }
      view.setInput(referencedByInput(`Referenced By: ${pluginRowName(plugin)}`, anchor, () => locations(plugin), first));
    },
  };
}
