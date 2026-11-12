import { addressOfRef, judge, type BrokenRule, type PluginFactsOf } from '../sortingRules/judge';
import { suggestedMove } from '../sortingRules/suggestedMove';
import { fileExtension } from '../tables/pluginFile';
import { dropIndexIn, type Drop } from './dropIndex';

/** What the game reads that a move is judged over: the plugins it loads with no line, every plugins.txt line, and which
 *  lines are active. */
export interface ListedPlugins {
  readonly loadedWithNoLine: readonly string[];
  readonly lines: readonly string[];
  readonly isActive: (name: string) => boolean;
}

function movedOrder(order: readonly string[], moved: readonly string[], drop: Drop): string[] {
  const movedSet = new Set(moved);
  const block = order.filter((name) => movedSet.has(name));
  const rest = order.filter((name) => !movedSet.has(name));
  rest.splice(dropIndexIn(order, moved, drop), 0, ...block);
  return rest;
}

const identity = (broken: { rule: string; plugins: readonly { origin: string; filename: string }[] }): string =>
  [broken.rule, ...broken.plugins.map((plugin) => `${plugin.origin}/${plugin.filename.toLowerCase()}`)].join('|');

/** Why moving `moved` to `drop` breaks a sorting rule at Error or adds a plugin the game moves, naming the plugins. Only
 *  what the move adds is refused: an order already broken is not the move's doing. */
export function moveOrderRefusal(
  { loadedWithNoLine, lines, isActive }: ListedPlugins, moved: readonly string[], drop: Drop, factsOf: PluginFactsOf,
): string | undefined {
  const brokenIn = (order: readonly string[]) => judge(loadedWithNoLine, order, factsOf, isActive).broken;
  const already = new Set(brokenIn(lines).map(identity));
  return brokenIn(movedOrder(lines, moved, drop)).find((broken) => (broken.level === 'error' || broken.rule === 'gameMoves') && !already.has(identity(broken)))?.reason;
}

/** A broken rule and the move of `mover` to `drop` that keeps it. */
export interface OfferedMove {
  rule: BrokenRule;
  mover: { name: string; origin: string };
  drop: Extract<Drop, { name: string }>;
}

/** The moves that keep a rule `broken` where a drop would land. A plugin with no line cannot move or be moved
 *  beside. */
export function offeredMoves(listed: ListedPlugins, broken: readonly BrokenRule[], factsOf: PluginFactsOf): OfferedMove[] {
  const lined = new Set(listed.lines.map((name) => name.toLowerCase()));
  return broken.flatMap((rule): OfferedMove[] => {
    const move = suggestedMove(rule);
    if (move === undefined || !lined.has(move.mover.filename.toLowerCase()) || !lined.has(move.anchor.filename.toLowerCase())) return [];
    const drop = { kind: move.side, name: move.anchor.filename };
    return moveOrderRefusal(listed, [move.mover.filename], drop, factsOf) === undefined ? [{ rule, mover: addressOfRef(move.mover), drop }] : [];
  });
}

// A plugin mEdit has not read loads as a master by its extension alone.
const factsOrExtension = (factsOf: PluginFactsOf): PluginFactsOf => (name) =>
  factsOf(name) ?? { origin: '', masters: [], blueprint: false, master: fileExtension(name) === '.esm' };

/** Where a new disabled line for `plugin` lands: after the last line, or directly before the plugin the game
 *  would load it ahead of, so the game moves nothing. */
export function landingDrop({ loadedWithNoLine, lines, isActive }: ListedPlugins, plugin: string, factsOf: PluginFactsOf): Drop {
  const placement = judge(loadedWithNoLine, [...lines, plugin], factsOrExtension(factsOf), isActive).broken
    .find((broken) => broken.rule === 'gameMoves' && broken.plugins.some((ref) => ref.filename === plugin))?.placement;
  return placement === undefined ? { kind: 'winningEnd' } : { kind: placement.side, name: placement.anchor.filename };
}
