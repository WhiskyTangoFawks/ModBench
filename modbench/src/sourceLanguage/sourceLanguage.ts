import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import type { OriginFilesOf } from '../instanceLoader/loadOrderSnapshot';
import { hoverAt } from './formKeyHover';
import { completionsAt } from './completion';
import { feedSourceProblems, type ProblemOnFile, type ProblemsByFile } from './sourceProblems';
import type { Reporter } from '../ports/reporter';

export interface SourceLanguageDeps {
  client: Pick<MEditClient, 'getComparison' | 'searchRecords' | 'getPluginProblems' | 'onNotification' | 'onReconnected'>;
  originFiles: OriginFilesOf;
  reporter: Pick<Reporter, 'report' | 'shownOnSurface'>;
}

const kinds = { reference: vscode.CompletionItemKind.Reference, enumMember: vscode.CompletionItemKind.EnumMember };
const pluginSource: vscode.DocumentSelector = { language: 'json' };

const diagnosticOf = ({ message, start, end }: ProblemOnFile): vscode.Diagnostic =>
  new vscode.Diagnostic(new vscode.Range(start.line, start.character, end.line, end.character), message, vscode.DiagnosticSeverity.Warning);

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
  return vscode.Disposable.from(hover, completion, sourceProblems(deps));
}
