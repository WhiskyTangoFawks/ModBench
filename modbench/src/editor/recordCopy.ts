import * as vscode from 'vscode';
import type { MEditClient, NotificationPayloads } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
import type { RecordCopy } from '../drivingLib/recordDocument';

export type CopyChanged = (copy: RecordCopy) => boolean;

/** Hands `changedWhere` the copies mEdit reports changed: those a rows-changed report touches, as
 *  `touches` reads it, each copy of a plugin mEdit read again whole, and every copy when its reports
 *  resume, since one may have been missed. */
export function followReportedCopies(
  client: Pick<MEditClient, 'onNotification' | 'onReconnected'>,
  changedWhere: (affects: CopyChanged) => void,
  touches: (report: NotificationPayloads['rows-changed']) => CopyChanged,
): vscode.Disposable {
  const unsubscribes = [
    client.onNotification('rows-changed', (report) => { changedWhere(touches(report)); }),
    client.onNotification('plugin-changed', ({ plugin }) => { changedWhere((copy) => samePluginAddress(copy.plugin, plugin)); }),
    client.onReconnected(() => { changedWhere(() => true); }),
  ];
  return new vscode.Disposable(() => { for (const unsubscribe of unsubscribes) unsubscribe(); });
}
