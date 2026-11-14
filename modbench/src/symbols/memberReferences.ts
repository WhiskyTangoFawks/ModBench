import type * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { SourceNames } from './sourceNames';
import { heldText } from '../textDocuments/heldText';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { locateCopies, locationOf } from './recordLocation';

type MemberReferences = Awaited<ReturnType<MEditClient['getFileReferences']>>;

const copiesNamingAtMembers = (answer: MemberReferences): Exclude<MemberReferences, { failed: unknown }> =>
  (isReadFailed(answer) ? { copies: [], unread: [`the plugins mEdit reads: ${failureReason(answer)}`] } : answer);

/** Each member of a record that names the symbol, at its document, and why each copy went unread. A copy whose document
 *  names it at no member sits at its FormKey (symbols.md, The features, story 10). */
export async function membersNaming(
  client: RecordDocumentClient, open: (uri: vscode.Uri) => PromiseLike<vscode.TextDocument>,
  names: Pick<SourceNames, 'membersIn' | 'formKeyIn'>, answer: MemberReferences,
): Promise<{ found: vscode.Location[]; unread: string[] }> {
  const { copies, unread } = copiesNamingAtMembers(answer);
  const { found, leftOut } = await locateCopies(client, copies, async (copy, uri) => {
    const document = await open(uri);
    const text = heldText(document);
    const spans = await names.membersIn(text, copy.formKey, copy.fieldPaths);
    const at = spans.length > 0 ? spans : [await names.formKeyIn(text, copy.formKey) ?? { start: 0, end: 0 }];
    return at.map((span) => locationOf({ uri, document, ...span }));
  });
  return { found: found.flat(), unread: [...unread, ...leftOut] };
}
