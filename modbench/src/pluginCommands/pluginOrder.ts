import { judge, type PluginFactsOf } from '../sortingRules/judge';
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
