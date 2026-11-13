import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import { isPluginSourcePath, type EntryRef } from '../instanceAdapter/instanceAdapter';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { heldText } from '../textDocuments/heldText';
import { openPluginSourceDocument } from '../textDocuments/pluginSource';
import { hoverAt } from './formKeyHover';
import { definitionsOf } from './formKeyDefinition';
import { referencesOf } from './formKeyReferences';
import { locateRecord, locationOf } from './recordLocation';
import { formKeyValue } from '../drivingLib/sourceText';
import { completionsAt } from './completion';
import { workspaceSymbolsOf, type RecordSymbol } from './workspaceSymbols';
import type { Instance } from '../instanceLoader/instance';
import { symbolIndex, type SymbolIndex } from './symbolIndex';
import type { EntryNames, EntrySymbol, PluginSymbol, SymbolOwner } from '../symbolNames/symbolNames';
import type { PluginsShown } from '../drivingLib/pluginsShown';
import { pluginLanguage } from './pluginLanguage';
import { entryLanguage } from './entryLanguage';
import { scriptLanguage, type ScriptClient } from './scriptLanguage';
import { fileLanguage, type FileClient, type FileCopies } from './fileLanguage';
import { renameSymbol } from './renameSymbol';
import type { ModRows, PluginRows } from '../drivingLib/symbolRows';
import { registerGoToMod, registerGoToPlugin, registerModReferencedBy, registerPluginReferencedBy } from './symbolCommands';

interface SymbolsDeps {
  instance: Pick<Instance, 'value' | 'subscribe'> | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: Pick<MEditClient, 'getComparison' | 'searchRecords' | 'getReferencesInActiveOrCompiledPlugins' | 'getPlugins' | 'getRecordOfFile'> & RecordDocumentClient & ScriptClient & FileClient;
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
  reporterFor: (tag: string) => Pick<Reporter, 'report'>;
  /** What the views say of their rows; absent with no instance. */
  rows: SymbolRows | undefined;
}

export interface SymbolRows {
  mods: ModRows;
  plugins: PluginRows;
}

// Go to Definition, and Go to Symbol in Workspace, are entry points to the plugin's `go to` (commands.md).
const goToPlugin = async (plugin: PluginSymbol): Promise<void> => {
  await vscode.commands.executeCommand('modbench.plugin.goTo', { argument: { kind: 'plugin', plugin } });
};

// Go to Definition is an entry point to the mod's `go to` (commands.md).
const goToMod = async (name: string): Promise<void> => {
  await vscode.commands.executeCommand('modbench.mod.goTo', { argument: { kind: 'mod', name } });
};

// Rename Symbol is an entry point to the plugin's `rename`, supplying the plugin and the new name (commands.md).
const renamePluginNamed = async (plugin: PluginSymbol, name: string): Promise<void> => {
  await vscode.commands.executeCommand('modbench.plugin.rename', undefined, undefined, { plugin, name });
};

const kinds = { reference: vscode.CompletionItemKind.Reference, enumMember: vscode.CompletionItemKind.EnumMember };
const pluginSource: vscode.DocumentSelector = { language: 'json' };
// symbols.md, The features, story 2: any file an owner of files reports may name a plugin.
const ownedFiles: vscode.DocumentSelector = [pluginSource, { scheme: 'file' }];
class PluginSymbolInformation extends vscode.SymbolInformation {
  constructor(readonly plugin: PluginSymbol, location: vscode.Location) {
    super(plugin.name, vscode.SymbolKind.File, plugin.origin, location);
  }
}

const entryShown: Record<EntrySymbol['kind'], { readonly kind: vscode.SymbolKind; readonly completion: vscode.CompletionItemKind; readonly word: string }> = {
  mod: { kind: vscode.SymbolKind.Package, completion: vscode.CompletionItemKind.Folder, word: 'mod' },
  separator: { kind: vscode.SymbolKind.Namespace, completion: vscode.CompletionItemKind.Folder, word: 'separator' },
  downloadedFile: { kind: vscode.SymbolKind.File, completion: vscode.CompletionItemKind.File, word: 'downloaded file' },
  profile: { kind: vscode.SymbolKind.Module, completion: vscode.CompletionItemKind.Folder, word: 'profile' },
};

class ScriptSymbolInformation extends vscode.SymbolInformation {
  constructor(name: string, location: vscode.Location) {
    super(name, vscode.SymbolKind.Class, 'Papyrus script', location);
  }
}

class EntrySymbolInformation extends vscode.SymbolInformation {
  constructor(readonly entry: EntrySymbol, location: vscode.Location) {
    super(entry.name, entryShown[entry.kind].kind, entryShown[entry.kind].word, location);
  }
}

// Located at its document's start until VS Code resolves it, when it is opened.
class RecordSymbolInformation extends vscode.SymbolInformation {
  constructor(readonly record: RecordSymbol) {
    super(record.name, vscode.SymbolKind.Object, `${record.plugin.name} (${record.plugin.origin})`, new vscode.Location(record.uri, new vscode.Position(0, 0)));
  }
}

interface Symbols extends vscode.Disposable {
  /** Each symbol's definition and the places that name it, read by symbol. */
  symbols: SymbolIndex;
}

/** A record's FormKey in its document, where Referenced By anchors its list. */
export function formKeyLocation(client: RecordDocumentClient) {
  return async (record: Parameters<typeof locateRecord>[1]): Promise<vscode.Location | { refused: string } | undefined> => {
    const found = await locateRecord({ client, open: openPluginSourceDocument }, record, formKeyValue);
    return found && ('refused' in found ? found : locationOf(found));
  };
}

type PluginLanguage = ReturnType<typeof pluginLanguage>;
type EntryLanguage = ReturnType<typeof entryLanguage>;
type ScriptLanguage = ReturnType<typeof scriptLanguage>;
type FileLanguage = ReturnType<typeof fileLanguage>;
type Spanned = { readonly start: number; readonly end: number };

const rangeIn = (document: vscode.TextDocument, { start, end }: Spanned): vscode.Range =>
  new vscode.Range(document.positionAt(start), document.positionAt(end));

const hoverOf = (document: vscode.TextDocument, { lines, ...span }: Spanned & { lines: readonly string[] }): vscode.Hover =>
  new vscode.Hover(new vscode.MarkdownString(lines.join('\n\n')), rangeIn(document, span));

function registerHover(deps: SymbolsDeps, plugin: PluginLanguage, entry: EntryLanguage, script: ScriptLanguage): vscode.Disposable {
  return vscode.languages.registerHoverProvider(ownedFiles, {
    async provideHover(document, position) {
      const offset = document.offsetAt(position);
      const ofPlugin = await plugin.hoverAt(document, offset);
      if (ofPlugin !== undefined) return hoverOf(document, ofPlugin);
      const ofEntry = await entry.hoverAt(document, offset);
      if (ofEntry !== undefined) return hoverOf(document, ofEntry);
      const ofScript = await script.hoverAt(document, offset);
      if (ofScript !== undefined) return hoverOf(document, ofScript);
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      const found = await hoverAt(deps, heldText(document), offset);
      return found && new vscode.Hover(new vscode.MarkdownString(found.markdown), rangeIn(document, found));
    },
  });
}

function registerCompletion(deps: SymbolsDeps, plugin: PluginLanguage, entry: EntryLanguage, script: ScriptLanguage): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider(ownedFiles, {
    async provideCompletionItems(document, position) {
      const ofEntry = await entry.completionsAt(document, document.offsetAt(position));
      if (ofEntry !== undefined) {
        return ofEntry.items.map((name) => {
          const item = new vscode.CompletionItem(name, entryShown[ofEntry.kind].completion);
          item.range = rangeIn(document, ofEntry);
          return item;
        });
      }
      const ofPlugin = await plugin.completionsAt(document, document.offsetAt(position));
      if (ofPlugin !== undefined) {
        return ofPlugin.items.map(({ name, origins }) => {
          const item = new vscode.CompletionItem({ label: name, description: origins.join(', ') }, vscode.CompletionItemKind.File);
          item.range = rangeIn(document, ofPlugin);
          return item;
        });
      }
      const ofScript = await script.completionsAt(document, document.offsetAt(position));
      if (ofScript !== undefined) {
        return ofScript.items.map((name) => {
          const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
          item.range = rangeIn(document, ofScript);
          return item;
        });
      }
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      const found = await completionsAt(deps, heldText(document), document.offsetAt(position));
      if (found === undefined) return undefined;
      const items = found.items.map(({ label, detail, insertText }) => {
        const item = new vscode.CompletionItem({ label, description: detail }, kinds[found.kind]);
        item.insertText = insertText;
        item.filterText = `${label} ${insertText}`;
        item.range = rangeIn(document, found);
        return item;
      });
      return new vscode.CompletionList(items, found.isIncomplete);
    },
  });
}

// A plugin's `go to` selects a row and the editor stays put, so the definition is the name asked about: VS Code stays
// where it is and says nothing.
function registerDefinition(deps: SymbolsDeps, plugin: PluginLanguage, entry: EntryLanguage, script: ScriptLanguage, file: FileLanguage): vscode.Disposable {
  const definitionAt = definitionsOf({ client: deps.client, reporter: deps.reporter, open: openPluginSourceDocument });
  return vscode.languages.registerDefinitionProvider(ownedFiles, {
    async provideDefinition(document, position) {
      const offset = document.offsetAt(position);
      const ofPlugin = await plugin.definitionAt(document, offset);
      if (ofPlugin !== undefined) return ofPlugin.resolved ? new vscode.Location(document.uri, rangeIn(document, ofPlugin)) : undefined;
      const ofMod = await entry.definitionAt(document, offset);
      if (ofMod !== undefined) return ofMod.resolved ? new vscode.Location(document.uri, rangeIn(document, ofMod)) : undefined;
      const ofScript = await script.definitionAt(document, offset);
      if (ofScript !== undefined) return ofScript.file === undefined ? undefined : new vscode.Location(vscode.Uri.file(ofScript.file), new vscode.Position(0, 0));
      const ofFile = await file.definitionAt(document, offset);
      if (ofFile !== undefined) return ofFile.resolved ? new vscode.Location(document.uri, rangeIn(document, ofFile)) : undefined;
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      const found = await definitionAt(heldText(document), offset);
      return found && locationOf(found);
    },
  });
}

function registerRename(deps: SymbolsDeps, plugin: PluginLanguage): vscode.Disposable {
  const symbol = renameSymbol({
    plugin, client: deps.client, plugins: () => deps.instance?.value.plugins ?? [],
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  });
  return vscode.languages.registerRenameProvider(ownedFiles, {
    async prepareRename(document, position) {
      const { placeholder, ...span } = await symbol.prepare(document, document.offsetAt(position));
      return { range: rangeIn(document, span), placeholder };
    },
    // The gesture applies its own changes, and writes after them what no workspace edit can hold.
    async provideRenameEdits(document, position, newName) {
      await symbol.rename(document, document.offsetAt(position), newName);
      return new vscode.WorkspaceEdit();
    },
  });
}

function registerReferences(deps: SymbolsDeps, plugin: PluginLanguage, entry: EntryLanguage, script: ScriptLanguage): vscode.Disposable {
  const referencesAt = referencesOf({ client: deps.client, reporter: deps.reporter, open: openPluginSourceDocument });
  return vscode.languages.registerReferenceProvider(ownedFiles, {
    async provideReferences(document, position) {
      const offset = document.offsetAt(position);
      const toPlugin = await plugin.referencesAt(document, offset);
      if (toPlugin !== undefined) return toPlugin;
      const toMod = await entry.referencesAt(document, offset);
      if (toMod !== undefined) return toMod;
      const toScript = await script.referencesAt(document, offset);
      if (toScript !== undefined) return toScript;
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      return (await referencesAt(heldText(document), offset)).map(locationOf);
    },
  });
}

function registerSymbols(deps: SymbolsDeps, plugin: PluginLanguage, entry: EntryLanguage, script: ScriptLanguage): vscode.Disposable {
  const workspace = workspaceSymbolsOf({ client: deps.client, reporter: deps.reporter, open: openPluginSourceDocument });
  const provider: vscode.WorkspaceSymbolProvider<RecordSymbolInformation | PluginSymbolInformation | EntrySymbolInformation | ScriptSymbolInformation> = {
    async provideWorkspaceSymbols(query) {
      const records = (await workspace.symbolsFor(query)).map((record) => new RecordSymbolInformation(record));
      const plugins = (await plugin.symbolsFor(query)).map((symbol) => new PluginSymbolInformation(symbol.plugin, symbol.location));
      const entries = (await entry.symbolsFor(query)).map((symbol) => new EntrySymbolInformation(symbol.entry, symbol.location));
      const scripts = script.symbolsFor(query).map(({ name, location }) => new ScriptSymbolInformation(name, location));
      return [...plugins, ...entries, ...scripts, ...records];
    },
    async resolveWorkspaceSymbol(symbol) {
      if (symbol instanceof PluginSymbolInformation) {
        await goToPlugin(symbol.plugin);
        return symbol;
      }
      if (symbol instanceof EntrySymbolInformation) {
        if (symbol.entry.kind === 'mod') await goToMod(symbol.entry.name);
        return symbol;
      }
      if (symbol instanceof ScriptSymbolInformation) return symbol;
      const found = await workspace.locate(symbol.record);
      if (found) symbol.location = locationOf(found);
      return symbol;
    },
  };
  return vscode.languages.registerWorkspaceSymbolProvider(provider);
}

export function createSymbols(deps: SymbolsDeps): Symbols {
  const plugin = pluginLanguage({ ...deps, renamePlugin: renamePluginNamed, goTo: goToPlugin, tooltip: (shown) => deps.pluginsShown?.tooltipLines(shown) ?? [] });
  const { instance, reporter, rows, reporterFor, entryOwners: owners, entryTooltip, downloadedFileTooltip, modOrderFileOf } = deps;
  const entry = entryLanguage({ instance, reporter, owners, goTo: goToMod, entryTooltip, downloadedFileTooltip, modOrderFileOf });
  const script = scriptLanguage({ instance, reporter, client: deps.client });
  const file = fileLanguage({ reporter, client: deps.client, ...deps.fileCopies });
  const disposable = vscode.Disposable.from(
    registerHover(deps, plugin, entry, script), registerCompletion(deps, plugin, entry, script), registerDefinition(deps, plugin, entry, script, file), registerRename(deps, plugin),
    registerReferences(deps, plugin, entry, script), registerSymbols(deps, plugin, entry, script),
    ...(rows && instance ? [
      registerGoToMod({ rows: rows.mods, reporter: reporterFor('mod.goTo') }),
      registerModReferencedBy({ referencedBy: { mod: entry.referencedBy, file: file.referencedBy }, rows: rows.mods, value: () => instance.value, reporter: reporterFor('mod.referencedBy') }),
      registerGoToPlugin({ rows: rows.plugins, reporter: reporterFor('pluginListTree.goTo') }),
      registerPluginReferencedBy({ referencedBy: plugin.referencedBy, rows: rows.plugins }),
    ] : []),
  );
  return {
    dispose: () => { disposable.dispose(); },
    symbols: symbolIndex({ client: deps.client, open: openPluginSourceDocument, plugin, entry, script, file }),
  };
}
