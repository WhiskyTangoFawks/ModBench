import { recordArgumentOf } from '../drivingLib/recordArgument';
import type { PluginAddress } from '../wire/pluginAddress';

/** A record to open: a copy when it names its plugin, else its winning copy. */
export interface RecordToOpen { formKey: string; plugin?: PluginAddress }

export interface RecordOpenPlan {
  addresses: RecordToOpen[];
  pinned: boolean;
}

function addressOf(node: unknown): RecordToOpen | undefined {
  const record = recordArgumentOf(node);
  return record?.plugin ? { formKey: record.formKey, plugin: record.plugin } : record && { formKey: record.formKey };
}

const isPinned = (argument: unknown): boolean =>
  typeof argument === 'object' && argument !== null && 'pinned' in argument && argument.pinned === true;

/** A palette entry or key hands over no Argument, so it takes the focused view's selection
 *  (commands.md, Principles). */
export function recordOpenPlan(argument: unknown, focusedSelection: readonly unknown[]): RecordOpenPlan {
  const subjects: readonly unknown[] = argument === undefined ? focusedSelection
    : Array.isArray(argument) ? argument : [argument];
  const addresses = subjects.flatMap((s) => addressOf(s) ?? []);
  return { addresses, pinned: subjects.some(isPinned) };
}

/** What a menu's open hands to open: the menu's selection, else its clicked row. */
export function pinnedArgument(row: unknown, selection: unknown) {
  const subjects = Array.isArray(selection) && selection.length > 0 ? selection : [row];
  return subjects.flatMap((s) => addressOf(s) ?? []).map((address) => ({ argument: { kind: 'record' as const, ...address }, pinned: true as const }));
}
