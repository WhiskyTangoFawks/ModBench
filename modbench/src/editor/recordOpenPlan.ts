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

const isOptionsOnly = (argument: unknown): boolean => isPinned(argument) && !(typeof argument === 'object' && argument !== null && 'argument' in argument);

/** A palette entry or key hands over no Argument, or only Options, so it takes the focused view's selection
 *  (commands.md, Principles). */
export function recordOpenPlan(argument: unknown, focusedSelection: readonly unknown[]): RecordOpenPlan {
  const given: readonly unknown[] = Array.isArray(argument) ? argument : [argument];
  const optionsOnly = argument !== undefined && given.every(isOptionsOnly);
  const subjects = argument === undefined || optionsOnly ? focusedSelection : given;
  const addresses = subjects.flatMap((s) => addressOf(s) ?? []);
  return { addresses, pinned: optionsOnly || subjects.some(isPinned) };
}

/** What a menu's open hands to open: the menu's selection, else its clicked row. */
export function pinnedArgument(row: unknown, selection: unknown) {
  const subjects = Array.isArray(selection) && selection.length > 0 ? selection : [row];
  return subjects.flatMap((s) => addressOf(s) ?? []).map((address) => ({ argument: { kind: 'record' as const, ...address }, pinned: true }));
}
