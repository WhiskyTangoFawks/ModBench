import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { copyDocumentUri } from '../textDocuments/recordDocument';
import { answerOf } from '../wire/readFailed';

/** Each place a copy that references `formKey` names it, at the copy's document, and why each copy went unread; a read
 *  mEdit fails throws. */
export function referencesToFormKey(
  client: Pick<MEditClient, 'getPlacedReferences'>,
): (formKey: string) => Promise<{ locations: vscode.Location[]; leftOut: string[] }> {
  return async (formKey) => {
    const { copies, leftOut } = answerOf(await client.getPlacedReferences(formKey));
    const locations = copies.flatMap(({ formKey: referrer, plugin, document, ranges }) => {
      const uri = copyDocumentUri({ formKey: referrer, plugin }, document);
      return ranges.map(({ start, end }) => new vscode.Location(uri, new vscode.Range(start.line, start.character, end.line, end.character)));
    });
    return { locations, leftOut };
  };
}
