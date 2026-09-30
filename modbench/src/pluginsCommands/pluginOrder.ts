// The plugin-order rules a move keeps: masters above their dependants, blueprint plugins last
// (plugins.md, Drag and drop, story 3; MO2's PluginList::setPluginPriority, pluginlist.cpp).

import { dropIndexIn, type Drop } from './dropIndex';

/** What the order rules read of one plugin, as mEdit answers it. */
export interface PluginOrderFacts {
  masters: readonly string[];
  blueprint: boolean;
}

/** `undefined` while mEdit cannot say, and a rule that needs the answer is not judged. */
export type PluginOrderFactsOf = (name: string) => PluginOrderFacts | undefined;

function movedOrder(order: readonly string[], moved: readonly string[], drop: Drop): string[] {
  const movedSet = new Set(moved);
  const block = order.filter((name) => movedSet.has(name));
  const rest = order.filter((name) => !movedSet.has(name));
  rest.splice(dropIndexIn(order, moved, drop), 0, ...block);
  return rest;
}

function positions(order: readonly string[]): Map<string, number> {
  return new Map(order.map((name, at) => [name, at] as const));
}

type MovesBehind = (first: string, second: string) => boolean;

function movesBehindIn(before: readonly string[], after: readonly string[]): MovesBehind {
  const was = positions(before);
  const is = positions(after);
  return (first, second) =>
    (was.get(first) ?? 0) < (was.get(second) ?? 0) && (is.get(first) ?? 0) > (is.get(second) ?? 0);
}

// MO2 holds master order only within one blueprint class; across the two, blueprint last decides.
function sameClassMasters(order: readonly string[], factsOf: PluginOrderFactsOf): [master: string, plugin: string][] {
  const listedByFolded = new Map(order.map((name) => [name.toLowerCase(), name] as const));
  return order.flatMap((plugin) => {
    const facts = factsOf(plugin);
    return (facts?.masters ?? [])
      .map((masterName) => listedByFolded.get(masterName.toLowerCase()))
      .filter((master): master is string => master !== undefined && factsOf(master)?.blueprint === facts?.blueprint)
      .map((master): [string, string] => [master, plugin]);
  });
}

function masterRefusal(order: readonly string[], factsOf: PluginOrderFactsOf, movesBehind: MovesBehind): string | undefined {
  const broken = sameClassMasters(order, factsOf).find(([master, plugin]) => movesBehind(master, plugin));
  return broken && `"${broken[0]}" is a master of "${broken[1]}", so it must load before it.`;
}

function blueprintRefusal(order: readonly string[], factsOf: PluginOrderFactsOf, movesBehind: MovesBehind): string | undefined {
  for (const blueprint of order.filter((name) => factsOf(name)?.blueprint === true)) {
    const other = order.find((name) => factsOf(name)?.blueprint === false && movesBehind(name, blueprint));
    if (other !== undefined) return `"${blueprint}" is a blueprint plugin, so it must load after "${other}", which is not.`;
  }
  return undefined;
}

/** Why moving `moved` to `drop` breaks `order`, plugins.txt's names losing end first, naming both
 *  plugins. Only a pair the move turns round is refused: an order already broken is not the
 *  move's doing. */
export function moveOrderRefusal(
  order: readonly string[], moved: readonly string[], drop: Drop, factsOf: PluginOrderFactsOf,
): string | undefined {
  const after = movedOrder(order, moved, drop);
  const movesBehind = movesBehindIn(order, after);
  return masterRefusal(after, factsOf, movesBehind) ?? blueprintRefusal(after, factsOf, movesBehind);
}
