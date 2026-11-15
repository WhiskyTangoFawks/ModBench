import * as vscode from 'vscode';
import type { MEditClient, RecordIndexChange } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
import type { CopyChanged } from '../wire/recordCopy';

type NamedRecords = NonNullable<RecordIndexChange>[number] & { readonly keys: readonly string[] };

/** Hands `changedWhere` the copies mEdit reports changed: those a report naming records touches, as
 *  `touches` reads it, each copy of a plugin mEdit read again whole, and every copy when it read everything again. */
export function followReportedCopies(
  client: Pick<MEditClient, 'onDidChange'>,
  changedWhere: (affects: CopyChanged) => void,
  touches: (report: NamedRecords) => CopyChanged,
): vscode.Disposable {
  const subscription = client.onDidChange((change) => {
    if (change === undefined) { changedWhere(() => true); return; }
    for (const { plugin, keys } of change) {
      changedWhere(keys === undefined ? (copy) => samePluginAddress(copy.plugin, plugin) : touches({ plugin, keys }));
    }
  });
  return new vscode.Disposable(() => { subscription.dispose(); });
}
