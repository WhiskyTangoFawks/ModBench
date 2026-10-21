import type * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
import type { ChildRecordDocuments } from '../textDocuments/childRecordDocument';
import type { CopyChanged } from '../wire/recordCopy';
import { followReportedCopies } from './recordCopy';

/** A report names the records that changed. A change to any of them can be in a child's file, and a move can move its carrier. */
export function followCopiesIntoDocuments(
  client: Pick<MEditClient, 'onNotification' | 'onReconnected'>,
  children: Pick<ChildRecordDocuments, 'changedWhere'>,
  carrier: { followCarried(affects: CopyChanged): Promise<void> },
): vscode.Disposable {
  return followReportedCopies(client, (affects) => {
    children.changedWhere(affects);
    void carrier.followCarried(affects);
  }, ({ plugin }) => (copy) => samePluginAddress(copy.plugin, plugin));
}
