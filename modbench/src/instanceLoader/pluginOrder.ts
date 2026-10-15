import { exactPluginAddressKey, pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

interface Placed extends PluginAddress {
  readonly line: number | null;
  readonly winning: boolean;
}

/** The plugin order (ADR-0013): the plugins the game loads with no line, then the winning lines by
 *  line number. A plugin appears once, at its first place; one loaded with no line is the row `plugins` holds, else `absent`.
 *  `others` are the plugins left out of the order: an overridden copy, or a file no line names. */
export function pluginOrderOf<R extends Placed>(
  value: { readonly plugins: readonly R[]; readonly pluginsLoadedWithNoLine: readonly PluginAddress[] },
  absent: (address: PluginAddress) => R,
): { loadedWithNoLine: R[]; fromLines: (R & { line: number })[]; others: R[] } {
  const rowAt = new Map(value.plugins.map((p) => [exactPluginAddressKey(p), p] as const));
  const loadedWithNoLine = value.pluginsLoadedWithNoLine.map((address) => rowAt.get(exactPluginAddressKey(address)) ?? absent(address));
  const placed = new Set(loadedWithNoLine.map(pluginAddressKey));
  const fromLines = value.plugins
    .filter((p): p is R & { line: number } => p.line !== null && p.winning)
    .sort((a, b) => a.line - b.line)
    .filter((p) => {
      const key = pluginAddressKey(p);
      if (placed.has(key)) return false;
      placed.add(key);
      return true;
    });
  return { loadedWithNoLine, fromLines, others: value.plugins.filter((p) => !placed.has(pluginAddressKey(p))) };
}
