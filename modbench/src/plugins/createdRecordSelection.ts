import * as vscode from 'vscode';
import type { MEditClient, PluginAddress } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';

/** A plugin's group of one record type. */
export interface RecordGroup {
  plugin: PluginAddress;
  recordType: string;
}

/** Where a new record's row is: in its plugin's group of its type, or beneath its container's row. */
export type RecordPlace<Row> = RecordGroup | { container: Row };

export interface CreatedRecordSelectionDeps<Row> {
  client: Pick<MEditClient, 'onNotification'>;
  rowOf(place: RecordPlace<Row>, formKey: string): Promise<Row | undefined>;
  view: { reveal(row: Row, options: { select: boolean; focus: boolean }): PromiseLike<void> };
}

export interface CreatedRecordWatch<Row> {
  /** The record mEdit created, selected and opened once a change to its plugin names it. */
  select(place: RecordPlace<Row>, formKey: string): void;
  forget(): void;
}

/** Watched from before the create, since the change naming the new record can precede mEdit's
 *  answer to it. */
export function createdRecordSelection<Row>(deps: CreatedRecordSelectionDeps<Row>): {
  watch(plugin: PluginAddress): CreatedRecordWatch<Row>;
} {
  let forgetLatest: (() => void) | undefined;

  const selectAndOpen = async (place: RecordPlace<Row>, formKey: string): Promise<void> => {
    const row = await deps.rowOf(place, formKey);
    if (row !== undefined) await deps.view.reveal(row, { select: true, focus: true });
    void vscode.commands.executeCommand('modbench.record.open', { formKey });
  };

  return {
    watch(plugin) {
      forgetLatest?.();
      const named = new Set<string>();
      let created: { place: RecordPlace<Row>; formKey: string } | undefined;
      const settle = (): void => {
        if (created === undefined || !named.has(created.formKey) || forgetLatest !== forget) return;
        forget();
        void selectAndOpen(created.place, created.formKey);
      };
      const unsubscribe = deps.client.onNotification('rows-changed', (event) => {
        if (!samePluginAddress(event.plugin, plugin)) return;
        for (const key of event.keys) named.add(key);
        settle();
      });
      const forget = () => {
        unsubscribe();
        if (forgetLatest === forget) forgetLatest = undefined;
      };
      forgetLatest = forget;
      return {
        select(place, formKey) {
          created = { place, formKey };
          settle();
        },
        forget,
      };
    },
  };
}
