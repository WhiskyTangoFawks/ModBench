import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import type { RecordDocumentClient } from '../drivingLib/recordDocument';
import { hoverAt } from './formKeyHover';
import { definitionsOf } from './formKeyDefinition';
import { referencesOf } from './formKeyReferences';
import { locationOf } from './recordLocation';
import { completionsAt } from './completion';
import { workspaceSymbolsOf, type RecordSymbol } from './workspaceSymbols';
import { feedSourceProblems, type ProblemOnFile, type ProblemsByFile, type SourceProblemsDeps } from './sourceProblems';

export interface SourceLanguageDeps extends Pick<SourceProblemsDeps, 'originFiles' | 'reporter'> {
  client: Pick<MEditClient, 'getComparison' | 'searchRecords' | 'getReferences' | 'getPlugins'> & RecordDocumentClient & SourceProblemsDeps['client'];
}

const kinds = { reference: vscode.CompletionItemKind.Reference, enumMember: vscode.CompletionItemKind.EnumMember };
const pluginSource: vscode.DocumentSelector = { language: 'json' };

const diagnosticOf = ({ message, start, end }: ProblemOnFile): vscode.Diagnostic =>
  new vscode.Diagnostic(new vscode.Range(start.line, start.character, end.line, end.character), message, vscode.DiagnosticSeverity.Warning);

// Located at its document's start until VS Code resolves it, when it is opened.
class RecordSymbolInformation extends vscode.SymbolInformation {
  constructor(readonly record: RecordSymbol) {
    super(record.name, vscode.SymbolKind.Object, `${record.plugin.name} (${record.plugin.origin})`, new vscode.Location(record.uri, new vscode.Position(0, 0)));
  }
}

function sourceProblems(deps: SourceLanguageDeps): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('modbench-source');
  const publish = (problems: ProblemsByFile) => {
    collection.clear();
    collection.set([...problems].map(([file, onFile]) => [vscode.Uri.file(file), onFile.map(diagnosticOf)]));
  };
  const readText = async (file: string) => (await vscode.workspace.openTextDocument(vscode.Uri.file(file))).getText();
  const unsubscribe = feedSourceProblems({ ...deps, readText, publish });
  return new vscode.Disposable(() => { unsubscribe(); collection.dispose(); });
}

export function createSourceLanguage(deps: SourceLanguageDeps): vscode.Disposable {
  const { client } = deps;
  const hover = vscode.languages.registerHoverProvider(pluginSource, {
    async provideHover(document, position) {
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      const found = await hoverAt(client, document.getText(), document.offsetAt(position));
      if (found === undefined) return undefined;
      const range = new vscode.Range(document.positionAt(found.start), document.positionAt(found.end));
      return new vscode.Hover(new vscode.MarkdownString(found.markdown), range);
    },
  });
  const completion = vscode.languages.registerCompletionItemProvider(pluginSource, {
    async provideCompletionItems(document, position) {
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      const found = await completionsAt(client, document.getText(), document.offsetAt(position));
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
  const open = (uri: vscode.Uri) => vscode.workspace.openTextDocument(uri);
  const definitionAt = definitionsOf({ client, reporter: deps.reporter, open });
  const definition = vscode.languages.registerDefinitionProvider(pluginSource, {
    async provideDefinition(document, position) {
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      const found = await definitionAt(document.getText(), document.offsetAt(position));
      return found && locationOf(found);
    },
  });
  const referencesAt = referencesOf({ client, reporter: deps.reporter, open });
  const references = vscode.languages.registerReferenceProvider(pluginSource, {
    async provideReferences(document, position) {
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      return (await referencesAt(document.getText(), document.offsetAt(position))).map(locationOf);
    },
  });
  const workspace = workspaceSymbolsOf({ client, reporter: deps.reporter, open });
  const symbolProvider: vscode.WorkspaceSymbolProvider<RecordSymbolInformation> = {
    async provideWorkspaceSymbols(query) {
      return (await workspace.symbolsFor(query)).map((record) => new RecordSymbolInformation(record));
    },
    async resolveWorkspaceSymbol(symbol) {
      const found = await workspace.locate(symbol.record);
      if (found) symbol.location = locationOf(found);
      return symbol;
    },
  };
  const symbols = vscode.languages.registerWorkspaceSymbolProvider(symbolProvider);
  return vscode.Disposable.from(hover, completion, definition, references, symbols, sourceProblems(deps));
}
