import * as vscode from 'vscode';
import { errorMessage } from '../ports/errorMessage';
import { copyDocument, type RecordCopy, type RecordDocumentClient } from '../drivingLib/recordDocument';
import type { TextSpan } from './recordText';

export interface RecordLocationDeps<Document> {
  client: RecordDocumentClient;
  open: (uri: vscode.Uri) => PromiseLike<Document>;
}

export interface RecordLocation<Document> extends TextSpan { uri: vscode.Uri; document: Document }

export const locationOf = ({ uri, document, start, end }: RecordLocation<vscode.TextDocument>): vscode.Location =>
  new vscode.Location(uri, new vscode.Range(document.positionAt(start), document.positionAt(end)));

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
