import type * as vscode from 'vscode';
import { pluginAddressOf, samePluginAddress } from '../wire/pluginAddress';
import type { CopyItem, CopyMode, PluginAddress, PluginMetadata, RecordAddress } from '../client';

export interface CopyModeItem extends vscode.QuickPickItem {
  readonly mode: CopyMode;
}

const OVERRIDE_ITEM: CopyModeItem = {
  label: 'Override', detail: 'The record itself, under its own FormKey, in each plugin you pick.', mode: 'Override',
};
const NEW_ITEM: CopyModeItem = {
  label: 'New record', detail: 'A duplicate under the next free FormID of each plugin you pick.', mode: 'New',
};
const DEEP_ITEM: CopyModeItem = {
  label: 'Deep copy as override',
  detail: 'The record itself and all its child records, under their own FormKeys, in each plugin you pick.',
  mode: 'DeepOverride',
};

/** plugins.md, Copy, story 4: the mode first, in xEdit's navigator order; deep copy only when a
 *  selected record has child records. */
export function copyModeItems(offerDeep: boolean): readonly CopyModeItem[] {
  return offerDeep ? [OVERRIDE_ITEM, NEW_ITEM, DEEP_ITEM] : [OVERRIDE_ITEM, NEW_ITEM];
}

/** A deep copy is an override of the record and its child records, so it takes every override branch. */
export const isOverride = (mode: CopyMode): boolean => mode !== 'New';

export interface CopyDestinationItem extends vscode.QuickPickItem {
  readonly plugin: PluginAddress;
}

/** The plugins I can edit, each with its load position (plugins.md, Pickers, Copy). An override
 *  is not offered the one plugin every record already lives in: it is that copy. */
export function copyDestinationItems(
  plugins: readonly PluginMetadata[], mode: CopyMode, records: readonly RecordAddress[],
): CopyDestinationItem[] {
  const livesInEveryRecord = (p: PluginMetadata) => records.every((r) => samePluginAddress(pluginAddressOf(r), p));
  return plugins
    .filter((p) => p.isTracked && !p.isImmutable)
    .filter((p) => !isOverride(mode) || !livesInEveryRecord(p))
    .map((p) => ({
      label: p.name,
      description: p.loadOrderIndex === null || p.loadOrderIndex === undefined ? undefined : `[${p.loadOrderIndex}]`,
      plugin: { name: p.name, origin: p.origin },
    }));
}

// An override into the record's own plugin: that plugin already is the copy.
const intoItsOwnPlugin = ({ record, destination }: CopyItem): boolean => samePluginAddress(pluginAddressOf(record), destination);

/** The landed items that wrote a copy: mEdit writes nothing for an override into the record's own
 *  plugin, and nothing is said of it (commands.md, Doing nothing is not an error). */
export function copiesWritten(landed: readonly CopyItem[], mode: CopyMode): CopyItem[] {
  return isOverride(mode) ? landed.filter((item) => !intoItsOwnPlugin(item)) : [...landed];
}

/** Each record and picked destination where the destination already holds a copy of the record:
 *  what an override would replace. A record's own plugin holds the record, not a copy of it. */
export function heldCopies(
  records: readonly RecordAddress[], destinations: readonly PluginAddress[],
  holders: ReadonlyMap<string, readonly PluginAddress[]>,
): CopyItem[] {
  return records.flatMap((record) => destinations
    .filter((destination) => (holders.get(record.formKey) ?? []).some((holder) => samePluginAddress(holder, destination)))
    .map((destination) => ({ record, destination })))
    .filter((item) => !intoItsOwnPlugin(item));
}
