import * as vscode from 'vscode';
import { isRefused, type MEditClient, type PluginAddress } from '../client';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import { registerPluginsGesture, singularArgument } from './gestureEntry';
import type { PluginsTreeNode } from './PluginsTreeProvider';
import type { RecordGroup } from './createdRecordSelection';
import type { RecordWrite } from './recordWrite';

export interface RecordCreateDeps {
  client: Pick<MEditClient, 'createRecord' | 'getCreatableRecordTypes'>;
  reporter: Reporter;
  createdRecords: { selectWhenListed(group: RecordGroup): Promise<() => void> };
  write: RecordWrite;
}

async function pickRecordType(deps: RecordCreateDeps): Promise<string | undefined> {
  let items: (vscode.QuickPickItem & { type: string })[];
  try {
    items = (await deps.client.getCreatableRecordTypes()).map(({ type, displayName }) => ({ label: displayName, description: type, type }));
  } catch (error) {
    deps.reporter.report('error', 'Could not look up the record types to create.', errorMessage(error));
    return undefined;
  }
  return (await vscode.window.showQuickPick(items, { placeHolder: 'Record type' }))?.type;
}

/** xEdit's Add (plugins.md, Create record). */
export function registerRecordCreateCommand(
  deps: RecordCreateDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  return registerPluginsGesture('modbench.record.create', viewSelection, async (entry) => {
    const row = singularArgument(entry, 'plugin', 'recordType');
    if (row === undefined) return;
    const plugin: PluginAddress = { name: row.kind === 'plugin' ? row.plugin.name : row.plugin, origin: row.origin };
    const recordType = row.kind === 'recordType' ? row.recordType : await pickRecordType(deps);
    if (recordType === undefined) return;

    const forget = await deps.createdRecords.selectWhenListed({ plugin, recordType });
    await deps.write(async () => {
      const result = await deps.client.createRecord(plugin.name, plugin.origin, recordType);
      if (isRefused(result)) {
        forget();
        deps.reporter.report('error', result.message);
        return;
      }
      deps.reporter.landed(`Created ${result.formKey}.`);
    });
  });
}
