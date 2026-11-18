import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { ReadCancellation } from '../client/MEditClient';
import type { PlacedCopy } from '../symbolNames/symbolNames';
import { copyDocumentUri } from '../textDocuments/recordDocument';
import { answerOf } from '../wire/readFailed';

/** Each range of each placed copy, at the copy's document. */
export const placedLocations = (copies: readonly PlacedCopy[]): vscode.Location[] =>
  copies.flatMap(({ formKey, plugin, document, ranges }) => {
    const uri = copyDocumentUri({ formKey, plugin }, document);
    return ranges.map(({ start, end }) => new vscode.Location(uri, new vscode.Range(start.line, start.character, end.line, end.character)));
  });

/** Each place a copy that references `formKey` names it, at the copy's document, and why each copy went unread; a read
 *  mEdit fails throws. */
export function referencesToFormKey(
  client: Pick<MEditClient, 'getPlacedReferences'>,
): (formKey: string, token?: ReadCancellation) => Promise<{ locations: vscode.Location[]; leftOut: string[] }> {
  return async (formKey, token) => {
    const { copies, leftOut } = answerOf(await client.getPlacedReferences(formKey, token));
    return { locations: placedLocations(copies), leftOut };
  };
}
