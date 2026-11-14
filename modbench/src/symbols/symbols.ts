import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import type { EntryRef } from '../instanceAdapter/instanceAdapter';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { openPluginSourceDocument } from '../textDocuments/pluginSource';
import { locateRecord, locationOf } from './recordLocation';
import { formKeyValue } from './formKeyText';
import type { Instance } from '../instanceLoader/instance';
import { symbolIndex, type SymbolIndex } from './symbolIndex';
import type { EntryNames, PluginSymbol, SymbolOwner } from '../symbolNames/symbolNames';
import type { PluginsShown } from '../drivingLib/pluginsShown';
import { pluginLanguage } from './pluginLanguage';
import { entryLanguage } from './entryLanguage';
import { scriptLanguage, type ScriptClient } from './scriptLanguage';
import { fileLanguage, type FileClient, type FileCopies } from './fileLanguage';
import { recordLanguage, type RecordClient } from './recordLanguage';
import { renameSymbol } from './renameSymbol';
import { registerLanguageFeatures } from './languageFeatures';
import type { ModRows, PluginRows } from '../drivingLib/symbolRows';
import type { FilesHeld } from './symbolCommands';
import { registerGoToMod, registerGoToPlugin, registerModReferencedBy, registerPluginReferencedBy } from './symbolCommands';
import type { SymbolKinds } from './symbolKind';
import { registerRecordReferencedBy, type RecordReferencedByDeps } from './recordReferencedBy';
import { publishReferencesView } from '../drivingLib/referencesView';

interface SymbolsDeps {
  instance: Pick<Instance, 'value' | 'subscribe'> | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: Pick<MEditClient, 'getRecordOfFile'> & RecordClient & ScriptClient & FileClient & RecordReferencedByDeps['client'];
  /** The record of the tab in focus, else the one the user picks; undefined where none is. */
  focusedOrPickedRecord: () => Promise<string | undefined>;
  fileCopies: FileCopies;
  /** Each box that owns files, saying where they name a symbol (ADR-0028). */
  owners: readonly SymbolOwner[];
  /** Each box that owns files, saying where they name a symbol its name alone names. */
  entryOwners: readonly EntryNames[];
  /** The tooltip of the row Mods shows for a mod or a separator; undefined where it shows none. */
  entryTooltip: (entry: EntryRef) => string | undefined;
  /** The tooltip of the row Downloads shows for a downloaded file; undefined where it shows none. */
  downloadedFileTooltip: (name: string) => string | undefined;
  /** The file that holds a profile's mod order; undefined with no instance. */
  modOrderFileOf: (profile: string) => string | undefined;
  /** What Plugins shows of a plugin's row; absent with no instance. */
  pluginsShown: Pick<PluginsShown, 'tooltipLines'> | undefined;
  reporterFor: (tag: string) => Reporter;
  /** What the views say of their rows; absent with no instance. */
  rows: SymbolRows | undefined;
}

export interface SymbolRows {
  mods: ModRows;
  plugins: PluginRows;
  filesHeld: () => FilesHeld;
}

// Rename Symbol is an entry point to the plugin's `rename`, supplying the plugin and the new name (commands.md).
const renamePluginNamed = async (plugin: PluginSymbol, name: string): Promise<void> => {
  await vscode.commands.executeCommand('modbench.plugin.rename', undefined, undefined, { plugin, name });
};

interface Symbols extends vscode.Disposable {
  /** Each symbol's definition and the places that name it, read by symbol. */
  symbols: SymbolIndex;
}

/** A record's FormKey in its document, where Referenced By anchors its list. */
function formKeyLocation(client: RecordDocumentClient) {
  return async (record: Parameters<typeof locateRecord>[1]): Promise<vscode.Location | { refused: string } | undefined> => {
    const found = await locateRecord({ client, open: openPluginSourceDocument }, record, formKeyValue);
    return found && ('refused' in found ? found : locationOf(found));
  };
}

export function createSymbols(deps: SymbolsDeps): Symbols {
  const { instance, reporter, client, rows, reporterFor, fileCopies, focusedOrPickedRecord } = deps;
  const plugin = pluginLanguage({
    instance, reporter, client, owners: deps.owners, renamePlugin: renamePluginNamed, rows: () => rows?.plugins,
    tooltip: (shown) => deps.pluginsShown?.tooltipLines(shown) ?? [],
  });
  const { entryTooltip, downloadedFileTooltip, modOrderFileOf } = deps;
  const entry = entryLanguage({ instance, reporter, owners: deps.entryOwners, rows: () => rows?.mods, entryTooltip, downloadedFileTooltip, modOrderFileOf });
  const file = fileLanguage({ instance, reporter, client, ...fileCopies, tooltip: (path) => rows?.mods.fileTooltip(path) });
  const kinds: SymbolKinds = {
    plugin, entry, file,
    script: scriptLanguage({ instance, reporter, client }),
    record: recordLanguage({ client, reporter, open: openPluginSourceDocument }),
  };
  const rename = renameSymbol({
    plugin, client, plugins: () => instance?.value.plugins ?? [],
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  });
  const goTo = { kinds, reveal: fileCopies.reveal };
  const disposable = vscode.Disposable.from(
    registerLanguageFeatures({ kinds, reporter, reveal: fileCopies.reveal, rename }),
    publishReferencesView((key, value) => { void vscode.commands.executeCommand('setContext', key, value); }),
    registerRecordReferencedBy({ client, reporter: reporterFor('referencedBy'), locateRecord: formKeyLocation(client), focusedOrPickedRecord }),
    ...(rows ? [
      registerGoToMod({ ...goTo, rows: rows.mods, reporter: reporterFor('mod.goTo') }),
      registerModReferencedBy({ referencedBy: { mod: entry.referencedBy, file: file.referencedBy }, rows: rows.mods, value: rows.filesHeld, reporter: reporterFor('mod.referencedBy') }),
      registerGoToPlugin({ ...goTo, rows: rows.plugins, reporter: reporterFor('pluginListTree.goTo') }),
      registerPluginReferencedBy({ referencedBy: plugin.referencedBy, rows: rows.plugins }),
    ] : []),
  );
  return {
    dispose: () => { disposable.dispose(); },
    symbols: symbolIndex(kinds),
  };
}
