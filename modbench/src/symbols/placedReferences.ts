import * as vscode from 'vscode';
import type { PlacedReferences } from '../client/MEditClient';
import type { PlacedCopy } from '../symbolNames/symbolNames';
import { copyDocumentUri } from '../textDocuments/recordDocument';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';

/** Each range of each placed copy, at the copy's document. */
export const placedLocations = (copies: readonly PlacedCopy[]): vscode.Location[] =>
  copies.flatMap(({ formKey, plugin, document, ranges }) => {
    const uri = copyDocumentUri({ formKey, plugin }, document);
    return ranges.map(({ start, end }) => new vscode.Location(uri, new vscode.Range(start.line, start.character, end.line, end.character)));
  });

/** Each place mEdit placed, and why each copy it could not place went unread; a read mEdit failed lists none and says why. */
export function listedPlaced(answer: PlacedReferences | ReadFailed): { found: vscode.Location[]; unread: string[] } {
  if (isReadFailed(answer)) return { found: [], unread: [`the plugins mEdit reads: ${failureReason(answer)}`] };
  return { found: placedLocations(answer.copies), unread: answer.leftOut };
}
