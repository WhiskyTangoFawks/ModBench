import type * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { ReadCancellation } from '../client/MEditClient';
import { answerOf } from '../wire/readFailed';
import { placedLocations } from './placedReferences';

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
