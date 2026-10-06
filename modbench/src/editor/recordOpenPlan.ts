import { headerFormKeyOf } from '../wire/headerFormKey';
import type { PluginAddress } from '../wire/pluginAddress';

/** A record to open: a copy when it names its plugin, else its winning copy. */
export interface RecordToOpen { formKey: string; plugin?: PluginAddress }

export interface RecordOpenPlan {
  addresses: RecordToOpen[];
  beside: boolean;
  /** Only a lone record opened in place is a preview, which the next click replaces. */
  preview: boolean;
}

// An Argument names its plugin whole; a Plugins row names it by file name beside its origin.
interface Stated { formKey?: string; plugin?: string | PluginAddress }

interface StatedRecord extends Stated {
  kind?: string; record?: Stated; origin?: string; header?: PluginAddress;
}

const PLUGINS_RECORD_ROWS = new Set(['record', 'worldspace', 'cell', 'placed']);

// A Plugins record row nests its record's summary.
const statedBy = (n: StatedRecord): Stated => (n.kind === 'record' ? n.record ?? {} : n);

// A tree row states its record structurally, so a test can use literals shaped like the nodes.
function addressOf(node: unknown): RecordToOpen | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as StatedRecord;
  if (n.header) return { formKey: headerFormKeyOf(n.header), plugin: n.header };
  const { formKey, plugin } = statedBy(n);
  if (!formKey) return undefined;
  const copy = pluginOf(n, plugin);
  return copy ? { formKey, plugin: copy } : { formKey };
}

function pluginOf({ kind, origin }: StatedRecord, plugin: Stated['plugin']): PluginAddress | undefined {
  if (typeof plugin === 'object') return plugin;
  const isPluginsRow = kind !== undefined && PLUGINS_RECORD_ROWS.has(kind);
  return isPluginsRow && plugin !== undefined && origin ? { name: plugin, origin } : undefined;
}

function asksBeside(argument: unknown): boolean {
  return typeof argument === 'object' && argument !== null && 'placement' in argument && argument.placement === 'beside';
}

/** A palette entry or key hands over no Argument, so it takes the focused view's selection
 *  (commands.md, Principles). */
export function recordOpenPlan(argument: unknown, focusedSelection: readonly unknown[]): RecordOpenPlan {
  const subjects: readonly unknown[] = argument === undefined ? focusedSelection
    : Array.isArray(argument) ? argument : [argument];
  const addresses = subjects.flatMap((s) => addressOf(s) ?? []);
  const beside = subjects.some(asksBeside);
  return { addresses, beside, preview: !beside && addresses.length === 1 };
}

/** What a menu's open to the side hands to open: the menu's selection, else its clicked row. */
export function besideArgument(row: unknown, selection: unknown) {
  const subjects = Array.isArray(selection) && selection.length > 0 ? selection : [row];
  return subjects.flatMap((s) => addressOf(s) ?? []).map((address) => ({ ...address, placement: 'beside' as const }));
}
