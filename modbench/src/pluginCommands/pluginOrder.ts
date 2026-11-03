import { addressOfRef, judge, type BrokenRule, type PluginFactsOf } from '../sortingRules/judge';
import { suggestedMove } from '../sortingRules/suggestedMove';
import { dropIndexIn, type Drop } from './dropIndex';

function movedOrder(order: readonly string[], moved: readonly string[], drop: Drop): string[] {
  const movedSet = new Set(moved);
  const block = order.filter((name) => movedSet.has(name));
  const rest = order.filter((name) => !movedSet.has(name));
  rest.splice(dropIndexIn(order, moved, drop), 0, ...block);
  return rest;
}

const identity = (broken: { rule: string; plugins: readonly { origin: string; filename: string }[] }): string =>
  [broken.rule, ...broken.plugins.map((plugin) => `${plugin.origin}/${plugin.filename.toLowerCase()}`)].join('|');

/** Why moving `moved` to `drop` breaks a sorting rule at Error, naming the plugins. Only a rule the move
 *  breaks is refused: an order already broken is not the move's doing. */
export function moveOrderRefusal(
  order: readonly string[], moved: readonly string[], drop: Drop, factsOf: PluginFactsOf,
): string | undefined {
  const already = new Set(judge(order, factsOf).map(identity));
  return judge(movedOrder(order, moved, drop), factsOf)
    .find((broken) => broken.level === 'error' && !already.has(identity(broken)))?.reason;
}

/** A broken rule and the move of `mover` to `drop` that keeps it. */
export interface OfferedMove {
  rule: BrokenRule;
  mover: { name: string; origin: string };
  drop: Drop;
}

/** The moves that keep a rule `broken` without breaking another at Error, over `lines`, the plugins.txt order the move is
 *  written into. A plugin with no line in it cannot move or be moved beside. */
export function offeredMoves(lines: readonly string[], broken: readonly BrokenRule[], factsOf: PluginFactsOf): OfferedMove[] {
  const listed = new Set(lines.map((name) => name.toLowerCase()));
  return broken.flatMap((rule): OfferedMove[] => {
    const move = suggestedMove(rule);
    if (move === undefined || !listed.has(move.mover.filename.toLowerCase()) || !listed.has(move.anchor.filename.toLowerCase())) return [];
    const drop: Drop = { kind: move.side, name: move.anchor.filename };
    return moveOrderRefusal(lines, [move.mover.filename], drop, factsOf) === undefined ? [{ rule, mover: addressOfRef(move.mover), drop }] : [];
  });
}
