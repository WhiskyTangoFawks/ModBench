import type * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { placedLocations } from './formKeyReferences';

/** Each place a copy names the script or file, at the copy's document, and why each copy went unread. */
export function membersNaming(
  answer: Awaited<ReturnType<MEditClient['getPlacedScriptReferences']>>,
): { found: vscode.Location[]; unread: string[] } {
  if (isReadFailed(answer)) return { found: [], unread: [`the plugins mEdit reads: ${failureReason(answer)}`] };
  return { found: placedLocations(answer.copies), unread: answer.leftOut };
}
