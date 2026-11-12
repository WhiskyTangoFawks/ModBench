import { exactPluginAddressKey, pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

interface Placed extends PluginAddress {
  readonly line: number | null;
  readonly winning: boolean;
}

/** A plugin the game loads with no line that no row holds: enabled, winning and on no line. */
export const unplaced = <N extends PluginAddress>(address: N) => ({ ...address, line: null, enabled: true, winning: true });

/** The plugin order (ADR-0013): the plugins the game loads with no line, then the winning lines by line.
 *  A plugin appears once, at its first place. `others` are the plugins outside the order. */
export function pluginOrderOf<R extends Placed, N extends PluginAddress>(
  value: { readonly plugins: readonly R[]; readonly pluginsLoadedWithNoLine: readonly N[] },
  absent: (address: N) => R,
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

/** The Plugins view's order, also the one mEdit is handed: the plugins the game loads with no line, then the lines.
 *  Where blueprint plugins load last, one with no line follows the last line that is not one. */
export function viewOrder<R>(
  loadedWithNoLine: readonly R[], lines: readonly R[], isBlueprint: (plugin: R) => boolean, blueprintLoadsLast: boolean,
): R[] {
  if (!blueprintLoadsLast) return [...loadedWithNoLine, ...lines];
  const afterLastOrdinaryLine = lines.findLastIndex((line) => !isBlueprint(line)) + 1;
  return [
    ...loadedWithNoLine.filter((plugin) => !isBlueprint(plugin)),
    ...lines.slice(0, afterLastOrdinaryLine),
    ...loadedWithNoLine.filter(isBlueprint),
    ...lines.slice(afterLastOrdinaryLine),
  ];
}

/** The snapshot's active plugins, which hold the plugins the game loads with no line first and then the lines, in the view's order. */
export function activeViewOrder<R>(
  snapshot: { readonly active: readonly R[]; readonly loadedWithNoLine: readonly R[] }, isBlueprint: (plugin: R) => boolean, blueprintLoadsLast: boolean,
): R[] {
  return viewOrder(snapshot.loadedWithNoLine, snapshot.active.slice(snapshot.loadedWithNoLine.length), isBlueprint, blueprintLoadsLast);
}
