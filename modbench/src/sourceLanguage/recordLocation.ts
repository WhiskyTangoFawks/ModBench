import * as vscode from 'vscode';
import { errorMessage } from '../ports/errorMessage';
import { copyDocument, recordDocument, type RecordDocumentClient } from '../textDocuments/recordDocument';
import type { RecordCopy } from '../wire/recordCopy';
import type { TextSpan } from './sourceText';

export interface RecordLocationDeps<Document> {
  client: RecordDocumentClient;
  open: (uri: vscode.Uri) => PromiseLike<Document>;
}

export interface RecordLocation<Document> extends TextSpan { uri: vscode.Uri; document: Document }

export const locationOf = ({ uri, document, start, end }: RecordLocation<vscode.TextDocument>): vscode.Location =>
  new vscode.Location(uri, new vscode.Range(document.positionAt(start), document.positionAt(end)));

/** The span `spanIn` finds of a record in the document it opens as; a copy when it names its plugin,
 *  else its winning copy. */
export async function locateRecord<Document extends { getText(): string }>(
  { client, open }: RecordLocationDeps<Document>,
  record: Pick<RecordCopy, 'formKey'> & Partial<RecordCopy>,
  spanIn: (text: string, formKey: string) => TextSpan | undefined,
): Promise<RecordLocation<Document> | { refused: string } | undefined> {
  const opened = await recordDocument(client, record);
  if (!opened || 'refused' in opened) return opened;
  const document = await open(opened.uri);
  const span = spanIn(document.getText(), record.formKey);
  return span ? { uri: opened.uri, document, ...span } : { refused: `${opened.uri.path} states no ${record.formKey} member.` };
}

interface LocatedCopies<T> { found: T[]; leftOut: string[] }

/** `located` for each copy at its document; a copy refused or failing is left out, saying why. */
export async function locateCopies<Copy extends RecordCopy, T>(
  client: RecordDocumentClient, copies: readonly Copy[], located: (copy: Copy, uri: vscode.Uri) => T | Promise<T>,
): Promise<LocatedCopies<T>> {
  const results = await Promise.all(copies.map(async (copy): Promise<{ found: T } | { why: string }> => {
    try {
      const opened = await copyDocument(client, copy);
      return 'refused' in opened ? { why: opened.refused } : { found: await located(copy, opened.uri) };
    } catch (error) {
      return { why: `${copy.formKey} in ${copy.plugin.name} (${copy.plugin.origin}): ${errorMessage(error)}` };
    }
  }));
  return {
    found: results.flatMap((result) => 'found' in result ? [result.found] : []),
    leftOut: results.flatMap((result) => 'why' in result ? [result.why] : []),
  };
}
