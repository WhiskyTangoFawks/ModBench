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
import type { PluginSymbol, SymbolOwner } from '../symbolNames/symbolNames';
import type { PluginsShown } from '../drivingLib/pluginsShown';
import { pluginLanguage } from './pluginLanguage';

interface SourceLanguageDeps extends Pick<SourceProblemsDeps, 'sourceFiles'> {
  instance: Pick<Instance, 'value' | 'subscribe'> | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: Pick<MEditClient, 'getComparison' | 'searchRecords' | 'getReferencesInActiveOrCompiledPlugins' | 'getPlugins' | 'handUnsavedDocuments'> & RecordDocumentClient & SourceProblemsDeps['client'];
  /** Each box that owns files, saying where they name a symbol (ADR-0028). */
  owners: readonly SymbolOwner[];
  /** What Plugins shows of a plugin's row; absent with no instance. */
  pluginsShown: Pick<PluginsShown, 'tooltipLines'> | undefined;
}

// Go to Definition, and Go to Symbol in Workspace, are entry points to the plugin's `go to` (commands.md).
const goToPlugin = async (plugin: PluginSymbol): Promise<void> => {
  await vscode.commands.executeCommand('modbench.plugin.goTo', { argument: { kind: 'plugin', plugin } });
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
  constructor(readonly plugin: PluginSymbol, path: string) {
    super(plugin.name, vscode.SymbolKind.File, plugin.origin, new vscode.Location(vscode.Uri.file(path), new vscode.Position(0, 0)));
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

export function createSourceLanguage(deps: SourceLanguageDeps): SourceLanguage {
  const { client } = deps;
  const plugin = pluginLanguage({ ...deps, renamePlugin: renamePluginNamed, goTo: goToPlugin, tooltip: (shown) => deps.pluginsShown?.tooltipLines(shown) ?? [] });
  const hover = vscode.languages.registerHoverProvider(ownedFiles, {
    async provideHover(document, position) {
      const offset = document.offsetAt(position);
      const ofPlugin = await plugin.hoverAt(document, offset);
      if (ofPlugin !== undefined) {
        const range = new vscode.Range(document.positionAt(ofPlugin.start), document.positionAt(ofPlugin.end));
        return new vscode.Hover(new vscode.MarkdownString(ofPlugin.lines.join('\n\n')), range);
      }
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      const found = await hoverAt(deps, heldText(document), document.offsetAt(position));
      if (found === undefined) return undefined;
      const range = new vscode.Range(document.positionAt(found.start), document.positionAt(found.end));
      return new vscode.Hover(new vscode.MarkdownString(found.markdown), range);
    },
  });
  const completion = vscode.languages.registerCompletionItemProvider(ownedFiles, {
    async provideCompletionItems(document, position) {
      const ofPlugin = await plugin.completionsAt(document, document.offsetAt(position));
      if (ofPlugin !== undefined) {
        const range = new vscode.Range(document.positionAt(ofPlugin.start), document.positionAt(ofPlugin.end));
        return ofPlugin.items.map(({ name, origins }) => {
          const item = new vscode.CompletionItem({ label: name, description: origins.join(', ') }, vscode.CompletionItemKind.File);
          item.range = range;
          return item;
        });
      }
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      const found = await completionsAt(deps, heldText(document), document.offsetAt(position));
      if (found === undefined) return undefined;
      const range = new vscode.Range(document.positionAt(found.start), document.positionAt(found.end));
      const items = found.items.map(({ label, detail, insertText }) => {
        const item = new vscode.CompletionItem({ label, description: detail }, kinds[found.kind]);
        item.insertText = insertText;
        item.filterText = `${label} ${insertText}`;
        item.range = range;
        return item;
      });
      return new vscode.CompletionList(items, found.isIncomplete);
    },
  });
  const definitionAt = definitionsOf({ client, reporter: deps.reporter, open: openPluginSourceDocument });
  const definition = vscode.languages.registerDefinitionProvider(ownedFiles, {
    async provideDefinition(document, position) {
      if (await plugin.definitionAt(document, document.offsetAt(position))) return undefined;
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      const found = await definitionAt(heldText(document), document.offsetAt(position));
      return found && locationOf(found);
    },
  });
  const referencesAt = referencesOf({ client, reporter: deps.reporter, open: openPluginSourceDocument });
  const rename = vscode.languages.registerRenameProvider(ownedFiles, {
    async prepareRename(document, position) {
      const found = await plugin.renameRangeAt(document, document.offsetAt(position));
      if (found === undefined) throw new Error('Rename Symbol renames a plugin, and no plugin\'s name is here.');
      return { range: new vscode.Range(document.positionAt(found.start), document.positionAt(found.end)), placeholder: found.name };
    },
    // The gesture applies its own changes, and writes after them what no workspace edit can hold.
    async provideRenameEdits(document, position, newName) {
      await plugin.renameAt(document, document.offsetAt(position), newName);
      return new vscode.WorkspaceEdit();
    },
  });
  const references = vscode.languages.registerReferenceProvider(ownedFiles, {
    async provideReferences(document, position) {
      const offset = document.offsetAt(position);
      const toPlugin = await plugin.referencesAt(document, offset);
      if (toPlugin !== undefined) return toPlugin;
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      return (await referencesAt(heldText(document), offset)).map(locationOf);
    },
  });
  const workspace = workspaceSymbolsOf({ client, reporter: deps.reporter, open: openPluginSourceDocument });
  const symbolProvider: vscode.WorkspaceSymbolProvider<RecordSymbolInformation | PluginSymbolInformation> = {
    async provideWorkspaceSymbols(query) {
      const records = (await workspace.symbolsFor(query)).map((record) => new RecordSymbolInformation(record));
      return [...plugin.symbolsFor(query).map(({ path, ...symbol }) => new PluginSymbolInformation(symbol, path)), ...records];
    },
    async resolveWorkspaceSymbol(symbol) {
      if (symbol instanceof PluginSymbolInformation) {
        await goToPlugin(symbol.plugin);
        return symbol;
      }
      const found = await workspace.locate(symbol.record);
      if (found) symbol.location = locationOf(found);
      return symbol;
    },
  };
  const symbols = vscode.languages.registerWorkspaceSymbolProvider(symbolProvider);
  const problems = sourceProblems(deps);
  const disposable = vscode.Disposable.from(handUnsavedPluginSource(client, isPluginSourcePath), hover, completion, definition, rename, references, symbols, problems, ...(deps.instance ? [registerBuildEntryPoint({ instance: deps.instance, reporter: deps.reporter }), registerUpdateManifestEntryPoint({ instance: deps.instance, reporter: deps.reporter })] : []));
  return {
    dispose: () => { disposable.dispose(); },
    messages: () => problems.messages(),
    referencedBy: plugin.referencedBy,
  };
}
