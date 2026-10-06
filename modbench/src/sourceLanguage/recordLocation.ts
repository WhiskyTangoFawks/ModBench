import * as vscode from 'vscode';
import { findNodeAtLocation, type Node } from 'jsonc-parser';
import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import type { RecordDocumentClient } from '../drivingLib/recordDocument';

export interface TextSpan { start: number; end: number }

export interface RecordLocationDeps<Document> {
  client: RecordDocumentClient & Pick<MEditClient, 'getReferences'>;
  reporter: Pick<Reporter, 'report' | 'shownOnSurface'>;
  open: (uri: vscode.Uri) => PromiseLike<Document>;
}

export interface RecordLocation<Document> extends TextSpan { uri: vscode.Uri; document: Document }

export const locationOf = ({ uri, document, start, end }: RecordLocation<vscode.TextDocument>): vscode.Location =>
  new vscode.Location(uri, new vscode.Range(document.positionAt(start), document.positionAt(end)));

export const ownFormKey = (node: Node): Node | undefined =>
  node.type === 'object' ? findNodeAtLocation(node, ['FormKey']) : undefined;

export function recordObject(node: Node, formKey: string): Node | undefined {
  if (ownFormKey(node)?.value === formKey) return node;
  for (const child of node.children ?? []) {
    const found = recordObject(child, formKey);
    if (found) return found;
  }
  return undefined;
}
