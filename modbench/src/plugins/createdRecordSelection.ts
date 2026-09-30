import * as vscode from 'vscode';
import type { MEditClient, NotificationEvent } from '../client';
import { pluginAddressKey } from './trackedRepositories';
import { UNLIMITED_RECORDS } from './PluginTreeProvider';

/** A plugin's group of one record type: the plugin as (origin, filename). */
export interface RecordGroup {
  plugin: string;
  origin: string;
  recordType: string;
}

export interface CreatedRecordSelectionDeps<Row> {
  client: Pick<MEditClient, 'subscribe' | 'getRecords' | 'getActiveFilter'>;
  rowOf(group: RecordGroup, formKey: string): Promise<Row | undefined>;
  view: { reveal(row: Row, options: { select: boolean; focus: boolean }): PromiseLike<void> };
}

/** rows-changed names no type and no addition. A record the record filter hides is listed by no
 *  group, so it is the one key the change names beyond the group's listing. */
export function createdRecordSelection<Row>(deps: CreatedRecordSelectionDeps<Row>): {
  selectWhenListed(group: RecordGroup): Promise<() => void>;
} {
  let forgetLatest: (() => void) | undefined;

  const listing = async (group: RecordGroup): Promise<string[]> =>
    (await deps.client.getRecords(group.plugin, group.recordType, 0, UNLIMITED_RECORDS, group.origin)).items.map((r) => r.formKey);

  const created = async (group: RecordGroup, before: ReadonlySet<string>, event: NotificationEvent): Promise<string | undefined> => {
    const listed = (await listing(group)).find((formKey) => !before.has(formKey));
    if (listed !== undefined) return listed;
    const [only, ...more] = event.keys.filter((formKey) => !before.has(formKey));
    return more.length === 0 && (await deps.client.getActiveFilter()) !== null ? only : undefined;
  };

  const selectAndOpen = async (group: RecordGroup, formKey: string): Promise<void> => {
    const row = await deps.rowOf(group, formKey);
    if (row !== undefined) await deps.view.reveal(row, { select: true, focus: true });
    void vscode.commands.executeCommand('modbench.record.open', { formKey, label: formKey });
  };

  return {
    async selectWhenListed(group) {
      forgetLatest?.();
      const listed = await listing(group).catch(() => undefined);
      if (listed === undefined) return () => {};
      const before = new Set(listed);
      const address = pluginAddressKey(group.plugin, group.origin);
      const unsubscribe = deps.client.subscribe('rows-changed', (event) => {
        if (pluginAddressKey(event.plugin, event.origin) !== address) return;
        void created(group, before, event).catch(() => undefined).then(async (formKey) => {
          if (formKey === undefined || forgetLatest !== forget) return;
          forget();
          await selectAndOpen(group, formKey);
        });
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
