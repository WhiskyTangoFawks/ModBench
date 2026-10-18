import { exactPluginAddressKey, pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

interface Placed extends PluginAddress {
  readonly line: number | null;
  readonly winning: boolean;
}

/** The plugin order (ADR-0013): the plugins the game loads with no line, then the winning lines by line.
 *  A plugin appears once, at its first place. `others` are the plugins outside the order. */
export function pluginOrderOf<R extends Placed>(
  value: { readonly plugins: readonly R[]; readonly pluginsLoadedWithNoLine: readonly (PluginAddress & { readonly path: string })[] },
  absent: (address: PluginAddress & { readonly path: string }) => R,
): { loadedWithNoLine: R[]; fromLines: (R & { line: number })[]; others: R[] } {
  const rowAt = new Map(value.plugins.map((p) => [exactPluginAddressKey(p), p] as const));
  const loadedWithNoLine = value.pluginsLoadedWithNoLine.map((address) => rowAt.get(exactPluginAddressKey(address)) ?? absent(address));
  const noLineKeys = new Set(loadedWithNoLine.map(pluginAddressKey));
  const fromLines = value.plugins
    .filter((p): p is R & { line: number } => p.line !== null && p.winning && !noLineKeys.has(pluginAddressKey(p)))
    .sort((a, b) => a.line - b.line);
  const placed = new Set([...noLineKeys, ...fromLines.map(pluginAddressKey)]);
  return { loadedWithNoLine, fromLines, others: value.plugins.filter((p) => !placed.has(pluginAddressKey(p))) };
}
