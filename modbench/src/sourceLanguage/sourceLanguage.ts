import * as vscode from 'vscode';
import { modbenchDiagnostic } from '../drivingLib/modbenchDiagnostic';
import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import { isPluginSourcePath, PLUGIN_SOURCE_GLOB } from '../instanceAdapter/instanceAdapter';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { heldText } from '../textDocuments/heldText';
import { openPluginSourceDocument, readHeldText } from '../textDocuments/pluginSource';
import { hoverAt } from './formKeyHover';
import { definitionsOf } from './formKeyDefinition';
import { referencesOf } from './formKeyReferences';
import { locateRecord, locationOf } from './recordLocation';
import { formKeyValue } from './sourceText';
import { completionsAt } from './completion';
import { workspaceSymbolsOf, type RecordSymbol } from './workspaceSymbols';
import { handUnsavedPluginSource } from './handUnsaved';
import { registerBuildEntryPoint } from './buildEntryPoint';
import { registerUpdateManifestEntryPoint } from './updateManifestEntryPoint';
import type { Instance } from '../instanceLoader/instance';
import { feedSourceProblems, type ProblemOnFile, type ProblemsByFile, type SourceProblemsDeps } from './sourceProblems';
import type { EntryNames, EntrySymbol, PluginSymbol, SymbolOwner } from '../symbolNames/symbolNames';
import type { PluginsShown } from '../drivingLib/pluginsShown';
import { pluginLanguage } from './pluginLanguage';
import { entryLanguage } from './entryLanguage';

interface SourceLanguageDeps extends Pick<SourceProblemsDeps, 'sourceFiles'> {
  instance: Pick<Instance, 'value' | 'subscribe'> | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: Pick<MEditClient, 'getComparison' | 'searchRecords' | 'getReferencesInActiveOrCompiledPlugins' | 'getPlugins' | 'handUnsavedDocuments'> & RecordDocumentClient & SourceProblemsDeps['client'];
  /** Each box that owns files, saying where they name a symbol (ADR-0028). */
  owners: readonly SymbolOwner[];
  /** Each box that owns files, saying where they name a mod or a separator. */
  entryOwners: readonly EntryNames[];
  /** The tooltip of the row Mods shows for a mod or a separator; undefined where it shows none. */
  entryTooltip: (entry: EntrySymbol) => string | undefined;
  /** What Plugins shows of a plugin's row; absent with no instance. */
  pluginsShown: Pick<PluginsShown, 'tooltipLines'> | undefined;
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
const pluginSourceStatusSelector: vscode.DocumentSelector = { language: 'json', pattern: PLUGIN_SOURCE_GLOB };

const diagnosticOf = ({ message, start, end }: ProblemOnFile): vscode.Diagnostic =>
  modbenchDiagnostic(new vscode.Range(start.line, start.character, end.line, end.character), message, vscode.DiagnosticSeverity.Warning);

class PluginSymbolInformation extends vscode.SymbolInformation {
  constructor(readonly plugin: PluginSymbol, location: vscode.Location) {
    super(plugin.name, vscode.SymbolKind.File, plugin.origin, location);
  }
}

class EntrySymbolInformation extends vscode.SymbolInformation {
  constructor(readonly entry: EntrySymbol, location: vscode.Location) {
    super(entry.name, entry.kind === 'mod' ? vscode.SymbolKind.Package : vscode.SymbolKind.Namespace, entry.kind, location);
  }
}

// Located at its document's start until VS Code resolves it, when it is opened.
class RecordSymbolInformation extends vscode.SymbolInformation {
  constructor(readonly record: RecordSymbol) {
    super(record.name, vscode.SymbolKind.Object, `${record.plugin.name} (${record.plugin.origin})`, new vscode.Location(record.uri, new vscode.Position(0, 0)));
  }
}

interface SourceLanguage extends vscode.Disposable {
  messages(): string[];
  /** Lists each place a file names `plugin`, in VS Code's References view. */
  referencedBy(plugin: PluginSymbol): Promise<void>;
  /** Lists each place a file names the mod, in VS Code's References view. */
  referencedByMod(mod: string): Promise<void>;
}

function sourceProblems(deps: SourceLanguageDeps): Pick<SourceLanguage, 'dispose' | 'messages'> {
  const collection = vscode.languages.createDiagnosticCollection('modbench-source');
  const publish = (problems: ProblemsByFile) => {
    collection.clear();
    collection.set([...problems].map(([file, onFile]) => [vscode.Uri.file(file), onFile.map(diagnosticOf)]));
  };
  let status: vscode.LanguageStatusItem | undefined;
  const languageStatus = (text: string | undefined) => {
    if (text === undefined) { status?.dispose(); status = undefined; return; }
    status ??= vscode.languages.createLanguageStatusItem('modbench.sourceProblems', pluginSourceStatusSelector);
    status.severity = vscode.LanguageStatusSeverity.Warning;
    status.text = text;
  };
  const unsubscribe = feedSourceProblems({ ...deps, readText: readHeldText, publish, languageStatus });
  const disposable = new vscode.Disposable(() => { unsubscribe(); collection.dispose(); status?.dispose(); });
  return { dispose: () => { disposable.dispose(); }, messages: () => status === undefined ? [] : [status.text] };
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
type Spanned = { readonly start: number; readonly end: number };

const rangeIn = (document: vscode.TextDocument, { start, end }: Spanned): vscode.Range =>
  new vscode.Range(document.positionAt(start), document.positionAt(end));

const hoverOf = (document: vscode.TextDocument, { lines, ...span }: Spanned & { lines: readonly string[] }): vscode.Hover =>
  new vscode.Hover(new vscode.MarkdownString(lines.join('\n\n')), rangeIn(document, span));

function registerHover(deps: SourceLanguageDeps, plugin: PluginLanguage, entry: EntryLanguage): vscode.Disposable {
  return vscode.languages.registerHoverProvider(ownedFiles, {
    async provideHover(document, position) {
      const offset = document.offsetAt(position);
      const ofPlugin = await plugin.hoverAt(document, offset);
      if (ofPlugin !== undefined) return hoverOf(document, ofPlugin);
      const ofEntry = await entry.hoverAt(document, offset);
      if (ofEntry !== undefined) return hoverOf(document, ofEntry);
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      const found = await hoverAt(deps, heldText(document), offset);
      return found && new vscode.Hover(new vscode.MarkdownString(found.markdown), rangeIn(document, found));
    },
  });
}

function registerCompletion(deps: SourceLanguageDeps, plugin: PluginLanguage, entry: EntryLanguage): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider(ownedFiles, {
    async provideCompletionItems(document, position) {
      const ofEntry = await entry.completionsAt(document, document.offsetAt(position));
      if (ofEntry !== undefined) {
        return ofEntry.items.map((name) => {
          const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Folder);
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
function registerDefinition(deps: SourceLanguageDeps, plugin: PluginLanguage, entry: EntryLanguage): vscode.Disposable {
  const definitionAt = definitionsOf({ client: deps.client, reporter: deps.reporter, open: openPluginSourceDocument });
  return vscode.languages.registerDefinitionProvider(ownedFiles, {
    async provideDefinition(document, position) {
      const offset = document.offsetAt(position);
      const ofPlugin = await plugin.definitionAt(document, offset);
      if (ofPlugin !== undefined) return ofPlugin.resolved ? new vscode.Location(document.uri, rangeIn(document, ofPlugin)) : undefined;
      const ofMod = await entry.definitionAt(document, offset);
      if (ofMod !== undefined) return ofMod.resolved ? new vscode.Location(document.uri, rangeIn(document, ofMod)) : undefined;
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      const found = await definitionAt(heldText(document), offset);
      return found && locationOf(found);
    },
  });
}

function registerRename(plugin: PluginLanguage): vscode.Disposable {
  return vscode.languages.registerRenameProvider(ownedFiles, {
    async prepareRename(document, position) {
      const found = await plugin.renameRangeAt(document, document.offsetAt(position));
      if (found === undefined) throw new Error('Rename Symbol renames a plugin, and no plugin\'s name is here.');
      return { range: rangeIn(document, found), placeholder: found.name };
    },
    // The gesture applies its own changes, and writes after them what no workspace edit can hold.
    async provideRenameEdits(document, position, newName) {
      await plugin.renameAt(document, document.offsetAt(position), newName);
      return new vscode.WorkspaceEdit();
    },
  });
}

function registerReferences(deps: SourceLanguageDeps, plugin: PluginLanguage, entry: EntryLanguage): vscode.Disposable {
  const referencesAt = referencesOf({ client: deps.client, reporter: deps.reporter, open: openPluginSourceDocument });
  return vscode.languages.registerReferenceProvider(ownedFiles, {
    async provideReferences(document, position) {
      const offset = document.offsetAt(position);
      const toPlugin = await plugin.referencesAt(document, offset);
      if (toPlugin !== undefined) return toPlugin;
      const toMod = await entry.referencesAt(document, offset);
      if (toMod !== undefined) return toMod;
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      return (await referencesAt(heldText(document), offset)).map(locationOf);
    },
  });
}

function registerSymbols(deps: SourceLanguageDeps, plugin: PluginLanguage, entry: EntryLanguage): vscode.Disposable {
  const workspace = workspaceSymbolsOf({ client: deps.client, reporter: deps.reporter, open: openPluginSourceDocument });
  const provider: vscode.WorkspaceSymbolProvider<RecordSymbolInformation | PluginSymbolInformation | EntrySymbolInformation> = {
    async provideWorkspaceSymbols(query) {
      const records = (await workspace.symbolsFor(query)).map((record) => new RecordSymbolInformation(record));
      const plugins = (await plugin.symbolsFor(query)).map((symbol) => new PluginSymbolInformation(symbol.plugin, symbol.location));
      const entries = (await entry.symbolsFor(query)).map((symbol) => new EntrySymbolInformation(symbol.entry, symbol.location));
      return [...plugins, ...entries, ...records];
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
      const found = await workspace.locate(symbol.record);
      if (found) symbol.location = locationOf(found);
      return symbol;
    },
  };
  return vscode.languages.registerWorkspaceSymbolProvider(provider);
}

export function createSourceLanguage(deps: SourceLanguageDeps): SourceLanguage {
  const plugin = pluginLanguage({ ...deps, renamePlugin: renamePluginNamed, goTo: goToPlugin, tooltip: (shown) => deps.pluginsShown?.tooltipLines(shown) ?? [] });
  const entry = entryLanguage({ instance: deps.instance, reporter: deps.reporter, owners: deps.entryOwners, goTo: goToMod, tooltip: deps.entryTooltip });
  const problems = sourceProblems(deps);
  const entryPoints = deps.instance ? [registerBuildEntryPoint({ instance: deps.instance, reporter: deps.reporter }), registerUpdateManifestEntryPoint({ instance: deps.instance, reporter: deps.reporter })] : [];
  const disposable = vscode.Disposable.from(
    handUnsavedPluginSource(deps.client, isPluginSourcePath),
    registerHover(deps, plugin, entry), registerCompletion(deps, plugin, entry), registerDefinition(deps, plugin, entry), registerRename(plugin), registerReferences(deps, plugin, entry), registerSymbols(deps, plugin, entry),
    problems, ...entryPoints,
  );
  return {
    dispose: () => { disposable.dispose(); },
    messages: () => problems.messages(),
    referencedBy: plugin.referencedBy,
    referencedByMod: entry.referencedBy,
  };
}
