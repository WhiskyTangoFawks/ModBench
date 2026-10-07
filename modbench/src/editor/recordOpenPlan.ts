import { recordArgumentOf } from '../drivingLib/recordArgument';
import { headerFormKeyOf } from '../wire/headerFormKey';
import type { ViewColumn } from 'vscode';
import type { PluginAddress } from '../wire/pluginAddress';

/** A record to open: a copy when it names its plugin, else its winning copy. */
export interface RecordToOpen { formKey: string; plugin?: PluginAddress }

export interface TabPlace { document: string; viewColumn: ViewColumn }

type Placement = 'active' | 'beside' | TabPlace;

export interface RecordOpenPlan {
  addresses: RecordToOpen[];
  placement: Placement;
  preview: boolean;
}

// A command's own Argument names a copy whole, or only the record.
interface Stated { formKey?: string; plugin?: PluginAddress; header?: PluginAddress }

function addressOf(node: unknown): RecordToOpen | undefined {
  const row = recordArgumentOf(node);
  if (row) return { formKey: row.formKey, plugin: row.plugin };
  if (!node || typeof node !== 'object') return undefined;
  const { header, formKey, plugin } = node as Stated;
  if (header) return { formKey: headerFormKeyOf(header), plugin: header };
  if (!formKey) return undefined;
  return plugin ? { formKey, plugin } : { formKey };
}

const placementOf = (argument: unknown): unknown =>
  (typeof argument === 'object' && argument !== null && 'placement' in argument ? argument.placement : undefined);

const isTabPlace = (value: unknown): value is TabPlace =>
  typeof value === 'object' && value !== null && 'document' in value && typeof value.document === 'string'
  && 'viewColumn' in value && typeof value.viewColumn === 'number';

/** A palette entry or key hands over no Argument, so it takes the focused view's selection
 *  (commands.md, Principles). */
export function recordOpenPlan(argument: unknown, focusedSelection: readonly unknown[]): RecordOpenPlan {
  const subjects: readonly unknown[] = argument === undefined ? focusedSelection
    : Array.isArray(argument) ? argument : [argument];
  const addresses = subjects.flatMap((s) => addressOf(s) ?? []);
  const placements = subjects.map(placementOf);
  const placement = placements.includes('beside') ? 'beside' : placements.find(isTabPlace) ?? 'active';
  return { addresses, placement, preview: placement === 'active' && addresses.length === 1 };
}

/** What a menu's open to the side hands to open: the menu's selection, else its clicked row. */
export function besideArgument(row: unknown, selection: unknown) {
  const subjects = Array.isArray(selection) && selection.length > 0 ? selection : [row];
  return subjects.flatMap((s) => addressOf(s) ?? []).map((address) => ({ ...address, placement: 'beside' as const }));
}
