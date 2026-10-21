import * as vscode from 'vscode';
import type { MEditClient, NotificationPayloads } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
import type { CopyChanged } from '../wire/recordCopy';

/** Hands `changedWhere` the copies mEdit reports changed: those a rows-changed report touches, as
 *  `touches` reads it, and each copy of a plugin mEdit read again whole. */
export function followReportedCopies(
  client: Pick<MEditClient, 'onNotification'>,
  changedWhere: (affects: CopyChanged) => void,
  touches: (report: NotificationPayloads['rows-changed']) => CopyChanged,
): vscode.Disposable {
  const unsubscribes = [
    client.onNotification('rows-changed', (report) => { changedWhere(touches(report)); }),
    client.onNotification('plugin-changed', ({ plugin }) => { changedWhere((copy) => samePluginAddress(copy.plugin, plugin)); }),
  ];
  return new vscode.Disposable(() => { for (const unsubscribe of unsubscribes) unsubscribe(); });
}
