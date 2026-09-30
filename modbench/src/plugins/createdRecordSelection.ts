import * as vscode from 'vscode';
import { UNLIMITED_RECORDS, type MEditClient, type PluginAddress } from '../client';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import { pluginAddressKey } from './trackedRepositories';

/** A plugin's group of one record type. */
export interface RecordGroup {
  plugin: PluginAddress;
  recordType: string;
}

export interface CreatedRecordSelectionDeps<Row> {
  client: Pick<MEditClient, 'subscribe' | 'getRecords'>;
  reporter: Reporter;
  rowOf(group: RecordGroup, formKey: string): Promise<Row | undefined>;
  view: { reveal(row: Row, options: { select: boolean; focus: boolean }): PromiseLike<void> };
}

/** rows-changed names no type and no addition, so the new record is the one its group newly
 *  lists. The listing is unfiltered: a record the filter hides is never taken for the new one. */
export function createdRecordSelection<Row>(deps: CreatedRecordSelectionDeps<Row>): {
  selectWhenListed(group: RecordGroup): Promise<() => void>;
} {
  let forgetLatest: (() => void) | undefined;

  const listing = async ({ plugin, recordType }: RecordGroup): Promise<string[]> =>
    (await deps.client.getRecords(plugin.name, recordType, 0, UNLIMITED_RECORDS, plugin.origin, { unfiltered: true }))
      .items.map((r) => r.formKey);

  const reportUnselected = (group: RecordGroup, error: unknown): void => {
    deps.reporter.report(
      'warning', `Could not select and open the new ${group.recordType} record in "${group.plugin.name}".`, errorMessage(error));
  };

  const selectAndOpen = async (group: RecordGroup, formKey: string): Promise<void> => {
    const row = await deps.rowOf(group, formKey);
    if (row !== undefined) await deps.view.reveal(row, { select: true, focus: true });
    void vscode.commands.executeCommand('modbench.record.open', { formKey, label: formKey });
  };

  return {
    async selectWhenListed(group) {
      forgetLatest?.();
      let before: ReadonlySet<string>;
      try {
        before = new Set(await listing(group));
      } catch (error) {
        reportUnselected(group, error);
        return () => {};
      }
      const address = pluginAddressKey(group.plugin.name, group.plugin.origin);
      const settle = async (): Promise<void> => {
        let created: string | undefined;
        try {
          created = (await listing(group)).find((formKey) => !before.has(formKey));
        } catch (error) {
          if (forgetLatest !== forget) return;
          forget();
          reportUnselected(group, error);
          return;
        }
        if (created === undefined || forgetLatest !== forget) return;
        forget();
        await selectAndOpen(group, created);
      };
      const unsubscribe = deps.client.subscribe('rows-changed', (event) => {
        if (pluginAddressKey(event.plugin, event.origin) === address) void settle();
      });
      const forget = () => {
        unsubscribe();
        if (forgetLatest === forget) forgetLatest = undefined;
      };
      forgetLatest = forget;
      return forget;
    },
  };
}
