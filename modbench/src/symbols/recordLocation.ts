import * as vscode from 'vscode';
import { recordDocument, type RecordDocumentClient } from '../textDocuments/recordDocument';
import type { RecordCopy } from '../wire/recordCopy';
import type { TextSpan } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';

export interface RecordLocationDeps<Document> {
  client: RecordDocumentClient;
  open: (uri: vscode.Uri) => PromiseLike<Document>;
}

export interface RecordLocation<Document> extends TextSpan { uri: vscode.Uri; document: Document }

export const locationOf = ({ uri, document, start, end }: RecordLocation<Pick<vscode.TextDocument, 'positionAt'>>): vscode.Location =>
  new vscode.Location(uri, new vscode.Range(document.positionAt(start), document.positionAt(end)));

/** The span `spanIn` finds of a record in the document it opens as (recordDocument). */
export async function locateRecord<Document extends { getText(): string }>(
  { client, open }: RecordLocationDeps<Document>,
  record: Pick<RecordCopy, 'formKey'> & Partial<RecordCopy>,
  spanIn: (text: string, formKey: string) => Promise<TextSpan | undefined>,
): Promise<RecordLocation<Document> | { refused: string } | undefined> {
  const opened = await recordDocument(client, record);
  if (!opened || 'refused' in opened) return opened;
  const document = await open(opened.uri);
  const span = await spanIn(heldText(document), record.formKey);
  return span ? { uri: opened.uri, document, ...span } : { refused: `${opened.uri.path} states no ${record.formKey} member.` };
}
