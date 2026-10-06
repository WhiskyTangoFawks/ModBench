import { pluginAddressOf, type PluginAddress } from './pluginAddress';

// A plugin's column (ADR-0012), the key of every per-column map mEdit's field diffs carry. The
// brand makes comparing one against a bare plugin string a compile error; a mapped type erases it.
export type ColumnKey = string & { readonly __col: unique symbol };

/** The one mint point for `ColumnKey`, as mEdit's `ColumnKey.Of` spells it: a `|` delimiter,
 *  illegal in a Windows filename, and the Data origin elided. */
export function columnKey({ name, origin }: PluginAddress): ColumnKey {
  return (origin.toLowerCase() === 'data' ? name : `${name}|${origin}`) as ColumnKey;
}

/** A compared copy's column: the key mEdit names it by when it compares several records, which
 *  may hold two copies from one plugin, else its plugin's. */
export function copyColumnKey(copy: { plugin: string; origin: string; column?: string | null }): ColumnKey {
  return (copy.column ?? columnKey(pluginAddressOf(copy))) as ColumnKey;
}
