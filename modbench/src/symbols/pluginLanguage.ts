import * as vscode from 'vscode';
import type { PluginRows } from '../drivingLib/symbolRows';
import type { InstanceValue } from '../instanceLoader/instance';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { heldTexts, pluginNamed, samePlugin, type PluginName, type PluginSymbol, type SymbolOwner } from '../symbolNames/symbolNames';
import { heldText, unsavedTexts } from '../textDocuments/heldText';
import { openPluginSourceDocument } from '../textDocuments/pluginSource';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { headerFormKeyOf } from '../wire/headerFormKey';
import { pluginRowName } from '../wire/pluginAddress';
import { atFile, nameHolds, placeLocation, showReferencedBy, spelledAround, type AskedIn, type ListedLocations } from './symbolPlaces';
import { pluginReferencesOf, type PluginReference } from './pluginReferences';
import { locateRecord, locationOf } from './recordLocation';
import { formKeyPluginAt, formKeyValue } from './formKeyText';
import { selectingItsRow } from './definitionShown';
import type { Definition, Listed, Named, PluginNamed, References, SymbolKind } from './symbolKind';

interface PluginLanguageDeps {
  instance: { readonly value: Pick<InstanceValue, 'plugins'> } | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: RecordDocumentClient;
  owners: readonly SymbolOwner[];
  /** The plugin's `rename`, with the new name an entry point supplies. */
  renamePlugin: (plugin: PluginSymbol, newName: string) => Promise<void>;
  /** What Plugins shows of its rows; absent with no instance. */
  rows: () => Pick<PluginRows, 'show' | 'fileOf'> | undefined;
  /** The lines of the tooltip its row shows. */
  tooltip: (plugin: PluginSymbol) => readonly string[];
}

const locationOfReference = (found: PluginReference<vscode.TextDocument>): vscode.Location =>
  ('file' in found ? placeLocation(found) : locationOf(found));

/** A plugin as a symbol: inside a FormKey, and wherever an owner's file names it (symbols.md, The symbols, Plugin). */
export function pluginLanguage({ instance, reporter, client, owners, renamePlugin, rows, tooltip }: PluginLanguageDeps) {
  const read = pluginReferencesOf({
    owners, client, open: openPluginSourceDocument,
    plugins: () => instance?.value.plugins ?? [],
    held: () => heldTexts(unsavedTexts()),
  });
  const plugins = () => instance?.value.plugins ?? [];

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

  const unresolved = ({ name }: PluginName) => ({ refused: `Mod order resolves ${name} to no plugin.` });

  const rowNamed = (named: PluginName) => {
    const plugin = pluginNamed(named, plugins());
    if (plugin === undefined) return unresolved(named);
    return plugins().find((each) => samePlugin(each, plugin)) ?? { refused: `The instance holds no plugin ${named.name} from ${plugin.origin}.` };
  };

  const referencesTo = async (named: PluginName): Promise<References> => {
    const plugin = rowNamed(named);
    if ('refused' in plugin) return plugin;
    const { found, unread } = await read(plugin);
    return { locations: found.map(locationOfReference), unread };
  };

  // Referenced By anchors at the plugin's header, as a record's anchors at its FormKey; else at a place that names it.
  const anchorOf = (plugin: PluginSymbol) => async (first: ListedLocations): Promise<vscode.Location | { refused: string }> => {
    const header = await locateRecord({ client, open: openPluginSourceDocument }, { formKey: headerFormKeyOf(plugin), plugin }, formKeyValue)
      .catch((error: unknown) => ({ refused: errorMessage(error) }));
    if (header && !('refused' in header)) return locationOf(header);
    return first.locations[0] ?? { refused: header?.refused ?? `No active plugin holds ${headerFormKeyOf(plugin)}.` };
  };

  const kind: SymbolKind<PluginNamed> = {
    async nameAt(document, offset): Promise<Named<PluginNamed> | undefined> {
      const found = await nameWithSpan(document, offset);
      return found && { start: found.start, end: found.end, name: found.name, symbol: { kind: 'plugin', ...found.named } };
    },
    /** Its row in Plugins, else its file. */
    definitionOf(named): Promise<Definition> {
      const plugin = pluginNamed(named, plugins());
      if (plugin === undefined) return Promise.resolve(unresolved(named));
      const show = rows()?.show(plugin);
      if (show !== undefined) return Promise.resolve({ row: 'Plugins', show });
      const held = plugins().find((each) => samePlugin(each, plugin));
      const path = rows()?.fileOf(plugin) ?? held?.path;
      if (path !== undefined) return Promise.resolve({ shown: { kind: 'loose', path } });
      return Promise.resolve({ refused: held === undefined ? `The instance holds no plugin ${named.name} from ${plugin.origin}.` : 'Plugins shows no row for it and no file holds it.' });
    },
    referencesTo,
    tooltipOf(named) {
      const plugin = pluginNamed(named, plugins());
      return Promise.resolve(plugin ? tooltip(plugin) : []);
    },
    /** Each plugin file name with the mods that hold it, over the name so far. */
    async completionsAt(document, offset) {
      const found = await nameWithSpan(document, offset);
      if (found === undefined) return undefined;
      const byName = new Map<string, { label: string; origins: string[] }>();
      for (const { name, origin } of plugins()) {
        const item = byName.get(name.toLowerCase()) ?? { label: name, origins: [] };
        item.origins.push(origin);
        byName.set(name.toLowerCase(), item);
      }
      const items = [...byName.values()].sort((a, b) => a.label.localeCompare(b.label)).map(({ label, origins }) => ({ label, detail: origins.join(', ') }));
      return { start: found.start, end: found.end, icon: vscode.CompletionItemKind.File, items };
    },
    /** Each plugin copy whose file name holds `query`, at its file, else at a place a file names it. A copy with neither
     *  has no place to be listed at. */
    async symbolsFor(query) {
      const matching = plugins().filter(({ name }) => nameHolds(name, query));
      const placed = await Promise.all(matching.map(async ({ name, origin, path }): Promise<Listed | undefined> => {
        const plugin = { name, origin };
        const listedAt = (location: vscode.Location): Listed => ({
          name, detail: origin, icon: vscode.SymbolKind.File, location, resolve: selectingItsRow(() => kind.definitionOf({ kind: 'plugin', ...plugin })),
        });
        if (path !== undefined) return listedAt(atFile(path));
        const named = (await read(plugin)).found.find((reference) => 'file' in reference);
        return named && 'file' in named ? listedAt(placeLocation(named)) : undefined;
      }));
      return placed.filter((symbol) => symbol !== undefined);
    },
  };

  return {
    ...kind,
    /** The plugin's name at `offset`, which Rename Symbol offers to rename; undefined where no plugin's name is. */
    renameRangeAt: async (document: AskedIn, offset: number) => {
      const found = await nameWithSpan(document, offset);
      return found && { start: found.start, end: found.end, name: found.name };
    },
    /** Rename Symbol on the plugin whose name is at `offset`: the plugin's `rename` (symbols.md, The features, story 6). */
    renameAt: async (document: AskedIn, offset: number, newName: string): Promise<void> => {
      const named = await nameAt(document, offset);
      if (named === undefined) return;
      const plugin = pluginNamed(named, plugins());
      if (plugin === undefined) throw new Error(unresolved(named).refused);
      await renamePlugin(plugin, newName);
    },
    /** Lists each place a file names `plugin`, in VS Code's References view. */
    referencedBy: (plugin: PluginSymbol): Promise<void> => showReferencedBy({
      reporter, subject: pluginRowName(plugin), contextValue: 'modbench.pluginReferencedBy',
      references: () => referencesTo(plugin), anchorOf: anchorOf(plugin),
    }),
  };
}
