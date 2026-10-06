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
  /** The record mEdit created, selected and opened once a change to its plugin names it, or
   *  mEdit re-derives the whole plugin. */
  select(place: RecordPlace<Row>, formKey: string): void;
  forget(): void;
}

/** Watched from before the create, since the change landing the new record can precede mEdit's
 *  answer, so the keys named until then are kept. It settles once, and the next watch settles
 *  it. */
export function createdRecordSelection<Row>(deps: CreatedRecordSelectionDeps<Row>): {
  watch(plugin: PluginAddress): CreatedRecordWatch<Row>;
} {
  let forgetLatest: (() => void) | undefined;

  const selectAndOpen = async (plugin: PluginAddress, place: RecordPlace<Row>, formKey: string): Promise<void> => {
    const row = await deps.rowOf(place, formKey);
    if (row !== undefined) await deps.view.reveal(row, { select: true, focus: true });
    void vscode.commands.executeCommand('modbench.record.open', { formKey, plugin });
  };

  return {
    watch(plugin) {
      forgetLatest?.();
      let landed = false;
      let namedBeforeAnswer: Set<string> | undefined = new Set();
      let created: { place: RecordPlace<Row>; formKey: string } | undefined;
      const settle = (): void => {
        if (created === undefined || !landed || forgetLatest !== forget) return;
        forget();
        void selectAndOpen(plugin, created.place, created.formKey);
      };
      const unsubscribes = [
        deps.client.onNotification('rows-changed', (event) => {
          if (!samePluginAddress(event.plugin, plugin)) return;
          if (created === undefined) for (const key of event.keys) namedBeforeAnswer?.add(key);
          else landed ||= event.keys.includes(created.formKey);
          settle();
        }),
        // A plugin re-derived whole is announced with no keys (ADR-0015).
        deps.client.onNotification('plugin-changed', (event) => {
          if (!samePluginAddress(event.plugin, plugin)) return;
          landed = true;
          settle();
        }),
      ];
      const forget = () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
        if (forgetLatest === forget) forgetLatest = undefined;
      };
      forgetLatest = forget;
      return {
        select(place, formKey) {
          created = { place, formKey };
          landed ||= namedBeforeAnswer?.has(formKey) ?? false;
          namedBeforeAnswer = undefined;
          settle();
        },
        forget,
      };
    },
  };
}
