import type * as vscode from 'vscode';
import type { MEditClient, NotificationEvent } from '../client';
import { pluginAddressKey } from './trackedRepositories';

/** A record create wrote: its plugin as (origin, filename), its type and its FormKey. */
export interface CreatedRecord {
  plugin: string;
  origin: string;
  recordType: string;
  formKey: string;
}

export interface CreatedRecordSelectionDeps<Row extends vscode.TreeItem> {
  subscribe: MEditClient['subscribe'];
  recordRow(record: CreatedRecord): Promise<Row | undefined>;
  reveal(row: Row, options: { select: boolean; focus: boolean }): PromiseLike<void>;
  fire(command: string, ...args: unknown[]): unknown;
}

function brings(event: NotificationEvent, record: CreatedRecord): boolean {
  return pluginAddressKey(event.plugin, event.origin) === pluginAddressKey(record.plugin, record.origin)
    && event.keys.includes(record.formKey);
}

/** plugins.md, Pickers, Create record: the view selects the new record once the watch lists it,
 *  then fires its row's click as the entry point, using no result (commands.md). A row not shown
 *  then is dropped. */
export function selectCreatedRecords<Row extends vscode.TreeItem>(deps: CreatedRecordSelectionDeps<Row>): {
  selectWhenListed(record: CreatedRecord): void;
  dispose(): void;
} {
  let awaited: CreatedRecord | undefined;

  const selectAndOpen = async (row: Row): Promise<void> => {
    await deps.reveal(row, { select: true, focus: true });
    if (row.command === undefined) return;
    const args: readonly unknown[] = row.command.arguments ?? [];
    void deps.fire(row.command.command, ...args);
  };

  // The tree's own listener to the same notification re-reads mEdit first.
  const listedRow = async (record: CreatedRecord): Promise<Row | undefined> => {
    await Promise.resolve();
    return deps.recordRow(record);
  };

  // The watch can bring the record before create's own answer does.
  const selectIfAlreadyListed = async (record: CreatedRecord): Promise<void> => {
    const row = await listedRow(record);
    if (row === undefined || awaited !== record) return;
    awaited = undefined;
    await selectAndOpen(row);
  };

  const selectOnceListed = async (record: CreatedRecord): Promise<void> => {
    const row = await listedRow(record);
    if (row !== undefined) await selectAndOpen(row);
  };

  const unsubscribe = deps.subscribe('rows-changed', (event) => {
    const record = awaited;
    if (record === undefined || !brings(event, record)) return;
    awaited = undefined;
    void selectOnceListed(record);
  });

  return {
    selectWhenListed: (record) => {
      awaited = record;
      void selectIfAlreadyListed(record);
    },
    dispose: unsubscribe,
  };
}
