import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import type { OriginFilesOf } from '../instanceLoader/loadOrderSnapshot';
import { hoverAt } from './formKeyHover';
import { completionsAt } from './completion';

export interface SourceLanguageDeps {
  client: Pick<MEditClient, 'getComparison' | 'searchRecords'>;
  originFiles: OriginFilesOf;
}

const kinds = { reference: vscode.CompletionItemKind.Reference, enumMember: vscode.CompletionItemKind.EnumMember };
const pluginSource: vscode.DocumentSelector = { language: 'json' };

export function createSourceLanguage({ client }: SourceLanguageDeps): vscode.Disposable {
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
  return vscode.Disposable.from(hover, completion);
}
