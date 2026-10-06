import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { PLUGIN_SOURCE_FOLDER } from '../instanceAdapter/layout';
import { hoverAt } from './formKeyHover';

export interface SourceLanguageDeps {
  client: Pick<MEditClient, 'getComparison'>;
}

const PLUGIN_SOURCE: vscode.DocumentSelector = { language: 'json', pattern: `**/${PLUGIN_SOURCE_FOLDER}/**` };

/** VS Code's language features over plugin source, answered by the index through the mEdit client. */
export function createSourceLanguage({ client }: SourceLanguageDeps): vscode.Disposable {
  return vscode.languages.registerHoverProvider(PLUGIN_SOURCE, {
    async provideHover(document, position) {
      const hover = await hoverAt(client, document.getText(), document.offsetAt(position));
      if (hover === undefined) return undefined;
      const range = new vscode.Range(document.positionAt(hover.start), document.positionAt(hover.end));
      return new vscode.Hover(new vscode.MarkdownString(hover.markdown), range);
    },
  });
}
