import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import type { OriginFilesOf } from '../instanceLoader/loadOrderSnapshot';
import { hoverAt } from './formKeyHover';

export interface SourceLanguageDeps {
  client: Pick<MEditClient, 'getComparison'>;
  originFiles: OriginFilesOf;
}

export function createSourceLanguage({ client }: SourceLanguageDeps): vscode.Disposable {
  return vscode.languages.registerHoverProvider({ language: 'json' }, {
    async provideHover(document, position) {
      if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
      const hover = await hoverAt(client, document.getText(), document.offsetAt(position));
      if (hover === undefined) return undefined;
      const range = new vscode.Range(document.positionAt(hover.start), document.positionAt(hover.end));
      return new vscode.Hover(new vscode.MarkdownString(hover.markdown), range);
    },
  });
}
