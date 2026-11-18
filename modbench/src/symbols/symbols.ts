import * as vscode from 'vscode';
import type { MEditClient, PluginAddress, PluginFilePaths } from '../client';
import type { ProblemsAsker } from '../drivingLib/problemsAsker';
import { sourceNames } from './sourceNames';
import type { Reporter } from '../ports/reporter';
import type { SourceFilesOf } from '../instanceLoader/loadOrderSnapshot';
import type { EntryRef } from '../instanceAdapter/instanceAdapter';
import { openPluginSourceDocument } from '../textDocuments/pluginSource';
import type { Instance } from '../instanceLoader/instance';
import { pluginRowsOf } from './pluginRows';
import { symbolIndex, type SymbolIndex } from './symbolIndex';
import type { EntryNames, PluginSymbol, SymbolOwner } from '../symbolNames/symbolNames';
import type { PluginsShown } from '../drivingLib/pluginsShown';
import { pluginLanguage } from './pluginLanguage';
import { entryLanguage, type RenamableEntry } from './entryLanguage';
import { scriptLanguage, type ScriptClient } from './scriptLanguage';
import { fileLanguage, type FileClient, type FileCopies } from './fileLanguage';
import { recordLanguage, type RecordClient } from './recordLanguage';
import { renameSymbol } from './renameSymbol';
import { registerLanguageFeatures } from './languageFeatures';
import type { ModRows, PluginRows, Reveal } from '../drivingLib/symbolRows';
import { registerReferencedBy, type FilesHeld } from './referencedBy';
import { pickSymbol } from './symbolPick';
import { registerGoTo } from './goTo';
import { asked, REFERENCED_BY, type SymbolKinds } from './symbolKind';
import type { RecordReferencedByDeps } from './recordReferencedBy';
import { registerNamesNothing } from './namesNothing';
import { heardChanges } from './heardChanges';
import { publishReferencesView } from '../drivingLib/referencesView';

const NO_FILES: FilesHeld = { filesByMod: new Map(), dataFolderFiles: { kind: 'listed', files: new Map() } };

interface SymbolsDeps {
  instance: Pick<Instance, 'value' | 'subscribe'> | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: Pick<MEditClient, 'getRecordOfFile'> & RecordClient & ScriptClient & FileClient & RecordReferencedByDeps['client'];
  asker: Pick<ProblemsAsker<PluginFilePaths, unknown>, 'getPluginFilePaths' | 'inTurn' | 'forget' | 'onPluginChanged'>;
  /** What mEdit's record index names in plugin source. */
  names: Pick<MEditClient, 'getPluginSourceNames'>;
  focusedRecord: () => string | undefined;
  sourceFiles: SourceFilesOf;
  /** The text of a file on disk; undefined where it is gone. */
  savedText: (path: string) => Promise<string | undefined>;
  fileCopies: FileCopies;
  /** Each box that owns files, saying where they name a symbol (ADR-0028). */
  owners: readonly SymbolOwner[];
  /** Each box that owns files, saying where they name a symbol its name alone names. */
  entryOwners: readonly EntryNames[];
  /** The tooltip of the row Mods shows for a mod or a separator; undefined where it shows none. */
  entryTooltip: (entry: EntryRef) => string | undefined;
  /** The tooltip of the row Downloads shows for a downloaded file; undefined where it shows none. */
  downloadedFileTooltip: (name: string) => string | undefined;
  downloadedFileRow: (name: string) => Reveal | undefined;
  /** The file that holds a profile's mod order; undefined with no instance. */
  modOrderFileOf: (profile: string) => string | undefined;
  /** What Plugins shows of a plugin's row; absent with no instance. */
  pluginsShown: Pick<PluginsShown, 'tooltipLines'> | undefined;
  reporterFor: (tag: string) => Reporter;
  /** What the views say of their rows; absent with no instance. */
  rows: SymbolRows | undefined;
}

export interface SymbolRows {
  selection: () => readonly unknown[];
  mods: ModRows;
  plugins: PluginRows;
  filesHeld: () => FilesHeld;
}

// Rename Symbol is an entry point to each `rename`, supplying what is renamed and the new name (commands.md).
const renamePluginNamed = async (plugin: PluginSymbol, name: string): Promise<void> => {
  await vscode.commands.executeCommand('modbench.plugin.rename', undefined, undefined, { plugin, name });
};

const renameEntryNamed = async ({ kind, name: oldName }: RenamableEntry, newName: string): Promise<void> => {
  await vscode.commands.executeCommand(`modbench.${kind}.rename`, undefined, undefined, { oldName, newName });
};

interface Symbols extends vscode.Disposable {
  /** Each symbol's definition and the places that name it, read by symbol. */
  symbols: SymbolIndex;
}

export function createSymbols(deps: SymbolsDeps): Symbols {
  const { instance, reporter, client, rows, reporterFor, fileCopies, focusedRecord } = deps;
  const names = sourceNames({ names: deps.names, paths: deps.asker, sourceFiles: deps.sourceFiles, reporter });
  const pluginRows = () => (instance === undefined ? [] : pluginRowsOf(instance.value));
  const plugin = pluginLanguage({
    plugins: pluginRows, reporter, client, owners: deps.owners, names, renamePlugin: renamePluginNamed, rows: () => rows?.plugins,
    tooltip: (shown) => deps.pluginsShown?.tooltipLines(shown) ?? [],
  });
  const { entryTooltip, downloadedFileTooltip, downloadedFileRow, modOrderFileOf } = deps;
  const entry = entryLanguage({ instance, reporter, owners: deps.entryOwners, rows: () => rows?.mods, entryTooltip, downloadedFileTooltip, downloadedFileRow, modOrderFileOf, renameEntry: renameEntryNamed });
  const file = fileLanguage({ instance, reporter, client, names, ...fileCopies, tooltip: (path) => rows?.mods.fileTooltip(path) });
  const kinds: SymbolKinds = {
    plugin, entry, file,
    script: scriptLanguage({ instance, names, client, reporter, ...fileCopies }),
    record: recordLanguage({ client, names, reporter, open: openPluginSourceDocument }),
  };
  const changed = (listener: (plugin?: PluginAddress, keys?: readonly string[]) => void) => ({ dispose: heardChanges({ asker: deps.asker, instance }, listener) });
  const problems = vscode.languages.createDiagnosticCollection('modbench-names');
  const rename = renameSymbol({
    plugin, entry, names, client, plugins: pluginRows,
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  });
  const disposable = vscode.Disposable.from(
    problems,
    registerNamesNothing({ kinds, collection: problems, reporter, savedText: deps.savedText, instance, onChanged: changed, asker: deps.asker }),
    registerLanguageFeatures({ kinds, reporter, reveal: fileCopies.reveal, rename }),
    registerGoTo({ kinds, reporter: reporterFor('symbol.goTo'), reveal: fileCopies.reveal, selection: () => rows?.selection() ?? [], dataPathOf: (row) => rows?.mods.dataPathOf(row) }),
    publishReferencesView((key, value) => { void vscode.commands.executeCommand('setContext', key, value); }),
    registerReferencedBy({
      reporter: reporterFor('symbol.referencedBy'), referencedBy: (symbol) => asked(kinds, symbol).referencedBy(),
      selection: () => rows?.selection() ?? [], dataPathOf: (row) => rows?.mods.dataPathOf(row), filesHeld: () => rows?.filesHeld() ?? NO_FILES,
      focusedRecord, pick: () => pickSymbol(kinds, reporterFor('symbol.referencedBy'), REFERENCED_BY),
    }),
  );
  return {
    dispose: () => { disposable.dispose(); },
    symbols: symbolIndex(kinds),
  };
}
