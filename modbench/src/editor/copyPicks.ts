import type * as vscode from 'vscode';
import type { CopyItem, CopyMode, PluginAddress, PluginMetadata, RecordAddress } from '../client';

export interface CopyModeItem extends vscode.QuickPickItem {
  readonly mode: CopyMode;
}

/** plugins.md, Pickers, Copy: the mode first, in xEdit's navigator order. */
export const COPY_MODE_ITEMS: readonly CopyModeItem[] = [
  { label: 'Override', detail: 'The record itself, under its own FormKey, in each plugin you pick.', mode: 'Override' },
  { label: 'New record', detail: 'A duplicate under the next free FormID of each plugin you pick.', mode: 'New' },
];

export interface CopyDestinationItem extends vscode.QuickPickItem {
  readonly plugin: PluginAddress;
}

const samePlugin = (a: PluginAddress, b: { name: string; origin: string }): boolean =>
  a.name.toLowerCase() === b.name.toLowerCase() && a.origin === b.origin;

/** The plugins I can edit, each with its load position (plugins.md, Pickers, Copy). An override
 *  is not offered the one plugin every record already lives in: it is that copy. */
export function copyDestinationItems(
  plugins: readonly PluginMetadata[], mode: CopyMode, records: readonly RecordAddress[],
): CopyDestinationItem[] {
  const livesInEveryRecord = (p: PluginMetadata) =>
    records.every((r) => samePlugin({ name: r.plugin, origin: r.origin }, p));
  return plugins
    .filter((p) => p.isTracked && !p.isImmutable)
    .filter((p) => mode !== 'Override' || !livesInEveryRecord(p))
    .map((p) => ({
      label: p.name,
      description: p.loadOrderIndex === null || p.loadOrderIndex === undefined ? undefined : `[${p.loadOrderIndex}]`,
      plugin: { name: p.name, origin: p.origin },
    }));
}

/** Each record and picked destination where the destination already holds a copy of the record:
 *  what an override would replace. */
export function heldCopies(
  records: readonly RecordAddress[], destinations: readonly PluginAddress[],
  holders: ReadonlyMap<string, readonly PluginAddress[]>,
): CopyItem[] {
  return records.flatMap((record) => destinations
    .filter((destination) => (holders.get(record.formKey) ?? []).some((holder) => samePlugin(holder, destination)))
    .map((destination) => ({ record, destination })));
}
