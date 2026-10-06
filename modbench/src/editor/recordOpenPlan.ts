import { headerFormKeyOf } from '../wire/headerFormKey';
import type { PluginAddress } from '../wire/pluginAddress';

/** A record to open: a copy when it names its plugin, else the record as no plugin gives it. */
export interface RecordToOpen { formKey: string; plugin?: PluginAddress }

export interface RecordOpenPlan {
  addresses: RecordToOpen[];
  beside: boolean;
  /** Only a lone record opened in place is a preview, which the next click replaces. */
  preview: boolean;
}

interface StatedRecord {
  kind?: string; record?: { formKey?: string; plugin?: string }; formKey?: string; plugin?: unknown; origin?: string; header?: PluginAddress;
}

const PLUGINS_RECORD_ROWS = new Set(['record', 'worldspace', 'cell', 'placed']);

function isPluginAddress(value: unknown): value is PluginAddress {
  return typeof value === 'object' && value !== null
    && typeof Reflect.get(value, 'name') === 'string' && typeof Reflect.get(value, 'origin') === 'string';
}

// A tree row states its record structurally, so a test can use literals shaped like the nodes.
function addressOf(node: unknown): RecordToOpen | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as StatedRecord;
  if (n.header) return { formKey: headerFormKeyOf(n.header), plugin: n.header };
  const formKey = n.kind === 'record' ? n.record?.formKey : n.formKey;
  if (!formKey) return undefined;
  const plugin = pluginOf(n);
  return plugin ? { formKey, plugin } : { formKey };
}

// A Plugins row is its own plugin's copy (commands.md, Argument: "Singular means the clicked row").
function pluginOf(n: StatedRecord): PluginAddress | undefined {
  if (isPluginAddress(n.plugin)) return n.plugin;
  const name = n.kind === 'record' ? n.record?.plugin : n.plugin;
  const isPluginsRow = n.kind !== undefined && PLUGINS_RECORD_ROWS.has(n.kind);
  return isPluginsRow && typeof name === 'string' && n.origin ? { name, origin: n.origin } : undefined;
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
