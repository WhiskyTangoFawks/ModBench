import type * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { heldText } from '../textDocuments/heldText';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { locateCopies, locationOf } from './recordLocation';
import { formKeyValue, stringsAt } from './sourceText';

type MemberReferences = Awaited<ReturnType<MEditClient['getFileReferences']>>;

/** The copies mEdit says name a symbol at their members, or why it could not say. */
export const copiesNamingAtMembers = (answer: MemberReferences): Exclude<MemberReferences, { failed: unknown }> =>
  (isReadFailed(answer) ? { copies: [], unread: [`the plugins mEdit reads: ${failureReason(answer)}`] } : answer);

/** Each member of a record that names the symbol, at its document, and why each copy went unread. A copy whose document
 *  names it at no member sits at its FormKey (symbols.md, The features, story 10). */
export async function membersNaming(
  client: RecordDocumentClient, open: (uri: vscode.Uri) => PromiseLike<vscode.TextDocument>, answer: MemberReferences,
): Promise<{ found: vscode.Location[]; unread: string[] }> {
  const { copies, unread } = copiesNamingAtMembers(answer);
  const { found, leftOut } = await locateCopies(client, copies, async (copy, uri) => {
    const document = await open(uri);
    const text = heldText(document);
    const spans = stringsAt(text, copy.formKey, copy.fieldPaths);
    return (spans.length > 0 ? spans : [formKeyValue(text, copy.formKey) ?? { start: 0, end: 0 }]).map((span) => locationOf({ uri, document, ...span }));
  });
  return { found: found.flat(), unread: [...unread, ...leftOut] };
}
