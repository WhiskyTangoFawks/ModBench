import * as vscode from 'vscode';
import { referencesView, type ReferencesViewInput } from '../drivingLib/referencesView';
import type { InstanceValue } from '../instanceLoader/instance';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { heldTexts, pluginNamed, sameName, type PlaceInFile, type PluginName, type PluginSymbol, type SymbolOwner } from '../symbolNames/symbolNames';
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
  instance: { readonly value: Pick<InstanceValue, 'plugins'> } | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: RecordDocumentClient;
  owners: readonly SymbolOwner[];
  /** The plugin's `rename`, with the new name an entry point supplies. */
  renamePlugin: (plugin: PluginSymbol, newName: string) => Promise<void>;
  /** The plugin's `go to`. */
  goTo: (plugin: PluginSymbol) => Promise<void>;
  /** The lines of the tooltip its row shows. */
  tooltip: (plugin: PluginSymbol) => readonly string[];
}

// The span of `name` around `offset`, as the text spells it; an owner's name may sit anywhere in its file's text.
function spelledAround(text: string, offset: number, name: string): { start: number; end: number; name: string } | undefined {
  for (let start = Math.max(0, offset - name.length); start <= offset; start += 1) {
    const spelled = text.slice(start, start + name.length);
    if (sameName(spelled, name)) return { start, end: start + name.length, name: spelled };
  }
  return undefined;
}

type AskedIn = Pick<vscode.TextDocument, 'getText'> & { readonly uri: Pick<vscode.Uri, 'fsPath'> };

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
export function pluginLanguage({ instance, reporter, client, owners, renamePlugin, goTo, tooltip }: PluginLanguageDeps) {
  const referencesTo = pluginReferencesOf({
    owners, reporter, client, open: openPluginSourceDocument,
    plugins: () => instance?.value.plugins ?? [],
    held: () => heldTexts(unsavedTexts()),
  });
  const listed = (read: typeof referencesTo.forGesture) => async (plugin: PluginSymbol): Promise<ListedLocations> => {
    const { found, unread } = await read(plugin);
    return { locations: found.map(locationOfReference), unread: unread.length };
  };
  const [listedForGesture, listedForFeature] = [listed(referencesTo.forGesture), listed(referencesTo.forFeature)];

  const nameAt = async (document: AskedIn, offset: number): Promise<PluginName | undefined> => {
    const text = heldText(document);
    if (isPluginSourcePath(document.uri.fsPath)) return formKeyPluginAt(text, offset);
    for (const owner of owners) {
      const named = await owner.nameAt(document.uri.fsPath, text, offset);
      if (named !== undefined) return named;
    }
    return undefined;
  };

  const nameWithSpan = async (document: AskedIn, offset: number) => {
    const named = await nameAt(document, offset);
    const span = named && spelledAround(heldText(document), offset, named.name);
    return named && span && { named, ...span };
  };

  // Referenced By anchors at the plugin's header, as a record's anchors at its FormKey; else at a place that names it.
  const anchorOf = async (plugin: PluginSymbol, first: ListedLocations): Promise<vscode.Location | { refused: string }> => {
    const header = await locateRecord({ client, open: openPluginSourceDocument }, { formKey: headerFormKeyOf(plugin), plugin }, formKeyValue)
      .catch((error: unknown) => ({ refused: errorMessage(error) }));
    if (header && !('refused' in header)) return locationOf(header);
    return first.locations[0] ?? { refused: header?.refused ?? `No active plugin holds ${headerFormKeyOf(plugin)}.` };
  };

  return {
    /** Go to Definition on the plugin whose name is at `offset`: the plugin's `go to`. False where no plugin's name is. */
    definitionAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; resolved: boolean } | undefined> => {
      const found = await nameWithSpan(document, offset);
      if (found === undefined) return undefined;
      const plugin = pluginNamed(found.named, instance?.value.plugins ?? []);
      if (plugin) await goTo(plugin);
      else reporter.shownOnSurface('warning', `Go to Definition cannot go to ${found.named.name}.`, `Mod order resolves ${found.named.name} to no plugin.`);
      return { start: found.start, end: found.end, resolved: plugin !== undefined };
    },
    /** What a hover on the plugin's name at `offset` says: its row's tooltip, or its name when it has none. */
    hoverAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; lines: readonly string[] } | undefined> => {
      const found = await nameWithSpan(document, offset);
      if (found === undefined) return undefined;
      const plugin = pluginNamed(found.named, instance?.value.plugins ?? []);
      const lines = plugin ? tooltip(plugin) : [];
      return { start: found.start, end: found.end, lines: lines.length > 0 ? lines : [found.name] };
    },
    /** Completion where a file names a plugin: each plugin file name with the mods that hold it, over the name so far. */
    completionsAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; items: { name: string; origins: string[] }[] } | undefined> => {
      const found = await nameWithSpan(document, offset);
      if (found === undefined) return undefined;
      const byName = new Map<string, { name: string; origins: string[] }>();
      for (const { name, origin } of instance?.value.plugins ?? []) {
        const item = byName.get(name.toLowerCase()) ?? { name, origins: [] };
        item.origins.push(origin);
        byName.set(name.toLowerCase(), item);
      }
      return { start: found.start, end: found.end, items: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    },
    /** Go to Symbol in Workspace: each plugin copy whose file name holds `query`, at its file, else at a place a file
     *  names it. A copy with neither has no place to be listed at. */
    symbolsFor: async (query: string): Promise<{ plugin: PluginSymbol; location: vscode.Location }[]> => {
      const wanted = query.trim().toLowerCase();
      if (wanted === '') return [];
      const matching = (instance?.value.plugins ?? []).filter(({ name }) => name.toLowerCase().includes(wanted));
      const placed = await Promise.all(matching.map(async ({ name, origin, path }) => {
        const plugin = { name, origin };
        if (path !== undefined) return { plugin, location: new vscode.Location(vscode.Uri.file(path), new vscode.Range(0, 0, 0, 0)) };
        const named = (await referencesTo.forFeature(plugin)).found.find((reference) => 'file' in reference);
        return named && 'file' in named ? { plugin, location: placeLocation(named) } : undefined;
      }));
      return placed.filter((symbol) => symbol !== undefined);
    },
    /** The plugin's name at `offset`, which Rename Symbol offers to rename; undefined where no plugin's name is. */
    renameRangeAt: async (document: AskedIn, offset: number) => {
      const found = await nameWithSpan(document, offset);
      return found && { start: found.start, end: found.end, name: found.name };
    },
    /** Rename Symbol on the plugin whose name is at `offset`: the plugin's `rename` (source.md, In the text editor). */
    renameAt: async (document: AskedIn, offset: number, newName: string): Promise<void> => {
      const named = await nameAt(document, offset);
      if (named === undefined) return;
      const plugin = pluginNamed(named, instance?.value.plugins ?? []);
      if (plugin === undefined) throw new Error(`Mod order resolves ${named.name} to no plugin.`);
      await renamePlugin(plugin, newName);
    },
    /** Find All References on the plugin whose name is at `offset`; undefined where no plugin's name is. */
    referencesAt: async (document: AskedIn, offset: number): Promise<vscode.Location[] | undefined> => {
      const named = await nameAt(document, offset);
      if (named === undefined) return undefined;
      const plugin = pluginNamed(named, instance?.value.plugins ?? []);
      if (plugin) return (await listedForFeature(plugin)).locations;
      reporter.shownOnSurface('warning', `Find All References cannot list what names ${named.name}.`, `Mod order resolves ${named.name} to no plugin.`);
      return [];
    },
    /** Lists each place a file names `plugin`, in VS Code's References view. */
    referencedBy: async (plugin: PluginSymbol): Promise<void> => {
      const view = await referencesView();
      if (!view) return;
      const first = await listedForGesture(plugin);
      const anchor = await anchorOf(plugin, first);
      if ('refused' in anchor) {
        reporter.report('error', `Could not list where files name ${pluginRowName(plugin)}.`, anchor.refused);
        return;
      }
      view.setInput(referencedByInput(`Referenced By: ${pluginRowName(plugin)}`, anchor, () => listedForGesture(plugin), first));
    },
  };
}
