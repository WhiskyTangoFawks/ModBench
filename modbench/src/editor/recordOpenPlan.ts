import { recordArgumentOf } from '../drivingLib/recordArgument';
import type { PluginAddress } from '../wire/pluginAddress';

/** A record to open: a copy when it names its plugin, else its winning copy. */
export interface RecordToOpen { formKey: string; plugin?: PluginAddress }

type Placement = 'active' | 'beside';

export interface RecordOpenPlan {
  addresses: RecordToOpen[];
  placement: Placement;
  preview: boolean;
}

function addressOf(node: unknown): RecordToOpen | undefined {
  const record = recordArgumentOf(node);
  return record?.plugin ? { formKey: record.formKey, plugin: record.plugin } : record && { formKey: record.formKey };
}

const placementOf = (argument: unknown): unknown =>
  (typeof argument === 'object' && argument !== null && 'placement' in argument ? argument.placement : undefined);

/** A palette entry or key hands over no Argument, so it takes the focused view's selection
 *  (commands.md, Principles). */
export function recordOpenPlan(argument: unknown, focusedSelection: readonly unknown[]): RecordOpenPlan {
  const subjects: readonly unknown[] = argument === undefined ? focusedSelection
    : Array.isArray(argument) ? argument : [argument];
  const addresses = subjects.flatMap((s) => addressOf(s) ?? []);
  const placements = subjects.map(placementOf);
  const placement = placements.includes('beside') ? 'beside' : 'active';
  return { addresses, placement, preview: placement === 'active' };
}

/** What a menu's open to the side hands to open: the menu's selection, else its clicked row. */
export function besideArgument(row: unknown, selection: unknown) {
  const subjects = Array.isArray(selection) && selection.length > 0 ? selection : [row];
  return subjects.flatMap((s) => addressOf(s) ?? []).map((address) => ({ argument: { kind: 'record' as const, ...address }, placement: 'beside' as const }));
}
